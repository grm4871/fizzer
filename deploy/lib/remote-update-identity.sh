# Remote update identity seam.
# Inputs are staged image metadata and host globals; outputs are verified globals/stdout; failures return nonzero.
# Source before preflight so every later phase consumes one immutable candidate identity.

load_release_candidate() {
  echo "==> Verifying staged release image for $REVISION"
  CANDIDATE_IMAGE="cascade:certified-$REVISION"

  local loaded_revision
  CERTIFIED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")"
  loaded_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE_IMAGE")"
  if [[ ! "$CERTIFIED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ || "$loaded_revision" != "$REVISION" ]]; then
    echo "Error: staged release image has an invalid identity or revision label." >&2
    return 1
  fi

  # Capacity evidence is optional for routine releases. When it is staged for
  # a capacity-sensitive change, still bind it to the exact image being run.
  if [[ -f "$CERTIFIED_MANIFEST" || -f "$CERTIFIED_MANIFEST.sha256" ]]; then
    local release_dir certification_part certified_image_id certified_image_tag
    for release_dir in "$CERTIFIED_RELEASE_DIR" "$CERTIFIED_IMAGE_DIR"; do
      if [[ -L "$release_dir" || ! -d "$release_dir" ]] ||
         [[ "$(stat -c '%u:%g:%a' "$release_dir")" != "0:0:700" ]]; then
        echo "Error: certification directories must be canonical root-owned directories, mode 0700." >&2
        return 1
      fi
    done
    for certification_part in "$CERTIFIED_MANIFEST" "$CERTIFIED_MANIFEST.sha256"; do
      if [[ -L "$certification_part" || ! -f "$certification_part" ]] ||
         [[ "$(stat -c '%u:%g:%a' "$certification_part")" != "0:0:600" ]]; then
        echo "Error: certification and checksum must be regular root-owned files, mode 0600." >&2
        return 1
      fi
    done
    certified_image_id="$(node deploy/certified-image.mjs verify --manifest "$CERTIFIED_MANIFEST")"
    certified_image_tag="$(node deploy/certified-image.mjs field --manifest "$CERTIFIED_MANIFEST" --name image.tag)"
    if [[ "$certified_image_id" != "$CERTIFIED_IMAGE_ID" || "$certified_image_tag" != "$CANDIDATE_IMAGE" ]]; then
      echo "Error: staged capacity certification differs from the release image." >&2
      return 1
    fi
    echo "==> Capacity certification matches the staged image"
  fi

  local embedded_gate
  embedded_gate="$(docker run --rm --network none \
    --entrypoint /app/release/bin/cascade_elixir "$CANDIDATE_IMAGE" eval \
    'if CascadeWeb.RouteCatalog.swap_ready?(), do: IO.puts("swap-ready"), else: System.halt(42)')"
  if [[ "$embedded_gate" != *"swap-ready"* ]]; then
    echo "Error: release image does not contain an approved cutover gate." >&2
    return 1
  fi
  echo "==> Release candidate is $CERTIFIED_IMAGE_ID"
}

verify_runtime_shape_json() {
  local label="${1:?runtime-shape label is required}"
  CASCADE_SHAPE_LABEL="$label" node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    const compose = parsed?.services?.cascade;
    const host = Array.isArray(parsed) ? parsed[0]?.HostConfig : null;
    const nofile = compose
      ? compose.ulimits?.nofile
      : host?.Ulimits?.find((entry) => entry.Name === "nofile");
    const actual = compose ? {
      cpus: Number(compose.cpus),
      cpuset: compose.cpuset,
      memory: Number(compose.mem_limit),
      memorySwap: Number(compose.memswap_limit),
      pids: Number(compose.pids_limit),
      nofileSoft: Number(nofile?.soft),
      nofileHard: Number(nofile?.hard),
    } : {
      cpus: Number(host?.NanoCpus) / 1_000_000_000,
      cpuset: host?.CpusetCpus,
      memory: Number(host?.Memory),
      memorySwap: Number(host?.MemorySwap),
      pids: Number(host?.PidsLimit),
      nofileSoft: Number(nofile?.Soft),
      nofileHard: Number(nofile?.Hard),
    };
    const expected = {
      cpus: 2,
      cpuset: "0-1",
      memory: 3 * 1024 ** 3,
      memorySwap: 3 * 1024 ** 3,
      pids: 100_000,
      nofileSoft: 200_000,
      nofileHard: 200_000,
    };
    const mismatches = Object.keys(expected)
      .filter((key) => actual[key] !== expected[key])
      .map((key) => `${key}=${actual[key] ?? "missing"} expected=${expected[key]}`);
    if (mismatches.length) {
      console.error(`Error: ${process.env.CASCADE_SHAPE_LABEL} differs from the certified runtime envelope: ${mismatches.join(", ")}`);
      process.exit(1);
    }
  '
  echo "==> $label matches the certified 2 CPU / 3 GiB runtime envelope"
}

verify_compose_runtime_shape() {
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" config --format json \
    | verify_runtime_shape_json "Compose candidate configuration"
}

verify_container_runtime_shape() {
  local container="${1:?container is required}"
  local label="${2:?runtime-shape label is required}"
  docker inspect "$container" | verify_runtime_shape_json "$label"
}

secure_production_environment() {
  local environment_file="$ROOT/.env"
  if [[ "$EUID" -ne 0 || -L "$environment_file" || ! -f "$environment_file" ]]; then
    echo "Error: production requires a regular root-managed .env file." >&2
    return 1
  fi
  chown 0:0 "$environment_file"
  chmod 0600 "$environment_file"
  if [[ "$(stat -c '%u:%g:%a' "$environment_file")" != "0:0:600" ]]; then
    echo "Error: production .env must be root-owned and mode 0600." >&2
    return 1
  fi
  echo "==> Production environment file permissions are secure"
}
