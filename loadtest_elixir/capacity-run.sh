#!/usr/bin/env bash

set -euo pipefail

original_args=("$@")
capacity_lib_dir="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")/lib"
source "$capacity_lib_dir/capacity-preflight.sh"
usage() {
  cat >&2 <<'EOF'
usage: capacity-run.sh --profile <diagnostic1k|final10k> --image sha256:<id> --data-template-dir <path> --data-dir <new-path> [--fault-data-dir <new-path> --soak-data-dir <new-path>] [--host-port <port>] [--container <name>] -- <checked-in controller options...>

The final10k profile runs three sequential, isolated candidates under one lock:
the authoritative 10k qualification, disposable fault proof, and disposable
5k/two-hour soak. The diagnostic1k profile runs exactly one diagnostic-only
candidate and cannot enter the release certification lifecycle.
Every candidate is created, preflighted while never-started, started, stopped,
and cleaned by exact owned ID. Production always invokes the checked-in
certification-runner.mjs; arguments after `--` are its options. The controller
receives:

  CASCADE_CAPACITY_CONTAINER_ID    immutable ID of the owned container
  CASCADE_CAPACITY_CONTAINER_NAME  exact configured container name
  CASCADE_CAPACITY_TARGET          loopback HTTP target for the candidate
  CASCADE_CAPACITY_PHASE           explicit lifecycle phase
  CASCADE_CAPACITY_DATA_DIR        host data root for the current phase

CAPACITY_RELEASE_COOKIE and CAPACITY_JWT_SECRET must already be set. Do not
background work past a controller invocation.
EOF
  exit 64
}

container=''
host_port='39094'
image=''
profile=''
data_dir=''
fault_data_dir=''
soak_data_dir=''
data_template_dir=''

while (($#)); do
  case "$1" in
    --profile)
      (($# >= 2)) || usage
      profile="$2"
      shift 2
      ;;
    --container)
      (($# >= 2)) || usage
      container="$2"
      shift 2
      ;;
    --data-dir)
      (($# >= 2)) || usage
      data_dir="$2"
      shift 2
      ;;
    --data-template-dir)
      (($# >= 2)) || usage
      data_template_dir="$2"
      shift 2
      ;;
    --fault-data-dir)
      (($# >= 2)) || usage
      fault_data_dir="$2"
      shift 2
      ;;
    --soak-data-dir)
      (($# >= 2)) || usage
      soak_data_dir="$2"
      shift 2
      ;;
    --host-port)
      (($# >= 2)) || usage
      host_port="$2"
      shift 2
      ;;
    --image)
      (($# >= 2)) || usage
      image="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

(( $# > 0 )) || usage
controller_args=("$@")
[[ "$profile" == 'diagnostic1k' || "$profile" == 'final10k' ]] || {
  echo 'Error: --profile must be diagnostic1k or final10k.' >&2
  exit 64
}
if [[ -z "$container" ]]; then
  if [[ "$profile" == 'diagnostic1k' ]]; then
    container='cascade-elixir-capacity-1k'
  else
    container='cascade-elixir-capacity'
  fi
fi

runner_profile=''
runner_source_database=''
runner_source_corpus_root=''
runner_fixture=''
runner_results_dir=''
runner_image=''
runner_image_id=''
runner_revision=''
if [[ "${CASCADE_CAPACITY_TESTING:-0}" != '1' ]]; then
  controller_index=0
  while (( controller_index < ${#controller_args[@]} )); do
    controller_option="${controller_args[$controller_index]}"
    [[ "$controller_option" == --* && "$controller_option" != *=* ]] || {
      echo 'Error: text after -- must contain only checked-in controller options.' >&2
      exit 64
    }
    (( controller_index + 1 < ${#controller_args[@]} )) || {
      echo "Error: controller option $controller_option requires a value." >&2
      exit 64
    }
    controller_value="${controller_args[$((controller_index + 1))]}"
    [[ -n "$controller_value" && "$controller_value" != --* ]] || {
      echo "Error: controller option $controller_option requires a value." >&2
      exit 64
    }
    case "$controller_option" in
      --profile)
        [[ -z "$runner_profile" ]] || { echo 'Error: duplicate controller --profile.' >&2; exit 64; }
        runner_profile="$controller_value"
        ;;
      --source-database)
        [[ -z "$runner_source_database" ]] || { echo 'Error: duplicate controller --source-database.' >&2; exit 64; }
        runner_source_database="$controller_value"
        ;;
      --source-corpus-root)
        [[ -z "$runner_source_corpus_root" ]] || { echo 'Error: duplicate controller --source-corpus-root.' >&2; exit 64; }
        runner_source_corpus_root="$controller_value"
        ;;
      --fixture)
        [[ -z "$runner_fixture" ]] || { echo 'Error: duplicate controller --fixture.' >&2; exit 64; }
        runner_fixture="$controller_value"
        ;;
      --results-dir)
        [[ -z "$runner_results_dir" ]] || { echo 'Error: duplicate controller --results-dir.' >&2; exit 64; }
        runner_results_dir="$controller_value"
        ;;
      --image)
        [[ -z "$runner_image" ]] || { echo 'Error: duplicate controller --image.' >&2; exit 64; }
        runner_image="$controller_value"
        ;;
      --image-id)
        [[ -z "$runner_image_id" ]] || { echo 'Error: duplicate controller --image-id.' >&2; exit 64; }
        runner_image_id="$controller_value"
        ;;
      --revision)
        [[ -z "$runner_revision" ]] || { echo 'Error: duplicate controller --revision.' >&2; exit 64; }
        runner_revision="$controller_value"
        ;;
      --source-ip|--soak-source-ip|--fixture-prefix)
        ;;
      *)
        echo "Error: unsupported checked-in controller option $controller_option." >&2
        exit 64
        ;;
    esac
    controller_index=$((controller_index + 2))
  done
  [[ "$runner_profile" == "$profile" ]] || {
    echo 'Error: wrapper and checked-in controller profiles must match.' >&2
    exit 64
  }
  [[ -n "$runner_source_database" && -n "$runner_source_corpus_root" \
      && -n "$runner_fixture" && -n "$runner_results_dir" \
      && -n "$runner_image_id" && -n "$runner_revision" ]] || {
    echo 'Error: controller image, revision, provenance, fixture, and results inputs are required.' >&2
    exit 64
  }
  [[ "$runner_image_id" == "$image" ]] || {
    echo 'Error: wrapper and controller immutable image IDs must match.' >&2
    exit 64
  }
  [[ "$runner_revision" =~ ^[a-f0-9]{40}$ ]] || {
    echo 'Error: controller revision must be a full Git SHA.' >&2
    exit 64
  }
  if [[ "$profile" == 'final10k' ]]; then
    [[ "$runner_image" == "cascade:certified-$runner_revision" ]] || {
      echo 'Error: final10k requires the canonical revision image tag.' >&2
      exit 64
    }
  else
    [[ -z "$runner_image" ]] || {
      echo 'Error: diagnostic1k cannot accept a final certification image tag.' >&2
      exit 64
    }
  fi
fi
[[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  echo 'Error: --image must be an immutable sha256 image ID.' >&2
  exit 64
}
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || {
  echo 'Error: --container is not a valid exact Docker container name.' >&2
  exit 64
}
[[ "$container" == 'cascade-elixir-capacity' || "$container" == cascade-elixir-capacity-* ]] || {
  echo 'Error: --container must stay in the reserved cascade-elixir-capacity namespace.' >&2
  exit 64
}
[[ "$host_port" =~ ^[0-9]+$ ]] && ((host_port >= 1 && host_port <= 65535)) || {
  echo 'Error: --host-port must be an integer from 1 through 65535.' >&2
  exit 64
}
[[ -n "$data_template_dir" && -d "$data_template_dir" \
    && -f "$data_template_dir/docs.db" && ! -L "$data_template_dir" \
    && ! -L "$data_template_dir/docs.db" ]] || {
  echo 'Error: --data-template-dir must be a real prepared capacity data tree.' >&2
  exit 64
}
if [[ "$profile" == 'final10k' ]]; then
  capacity_data_dirs=("$data_dir" "$fault_data_dir" "$soak_data_dir")
else
  [[ -z "$fault_data_dir" && -z "$soak_data_dir" ]] || {
    echo 'Error: diagnostic1k accepts only --data-dir and cannot enter final phase roots.' >&2
    exit 64
  }
  capacity_data_dirs=("$data_dir")
fi
for required_data_dir in "${capacity_data_dirs[@]}"; do
  [[ -n "$required_data_dir" && ! -e "$required_data_dir" && ! -L "$required_data_dir" ]] || {
    echo 'Error: every requested capacity data destination must be fresh and absent.' >&2
    exit 64
  }
done
: "${CAPACITY_RELEASE_COOKIE:?CAPACITY_RELEASE_COOKIE is required}"
: "${CAPACITY_JWT_SECRET:?CAPACITY_JWT_SECRET is required}"

command -v flock >/dev/null 2>&1 || {
  echo 'Error: flock is required for capacity-run serialization.' >&2
  exit 69
}
command -v docker >/dev/null 2>&1 || {
  echo 'Error: docker is required for capacity certification.' >&2
  exit 69
}
command -v sqlite3 >/dev/null 2>&1 || {
  echo 'Error: sqlite3 is required to freeze capacity evidence.' >&2
  exit 69
}
command -v sha256sum >/dev/null 2>&1 || {
  echo 'Error: sha256sum is required to freeze capacity evidence.' >&2
  exit 69
}
if [[ "${CASCADE_CAPACITY_TESTING:-0}" == '1' ]]; then
  # Unit tests use a tiny phase recorder instead of executing a real workload.
  controller_command=("${controller_args[@]}")
else
  command -v node >/dev/null 2>&1 || {
    echo 'Error: node is required for the checked-in capacity controller.' >&2
    exit 69
  }
  controller_script="$(dirname -- "$(readlink -f -- "$0")")/certification-runner.mjs"
  [[ -f "$controller_script" && ! -L "$controller_script" ]] || {
    echo 'Error: checked-in certification-runner.mjs is missing or unsafe.' >&2
    exit 69
  }
  checkout_root="$(dirname -- "$(dirname -- "$controller_script")")"
  [[ "$(git -C "$checkout_root" rev-parse HEAD)" == "$runner_revision" ]] || {
    echo 'Error: controller revision differs from the checked-out commit.' >&2
    exit 65
  }
  [[ -z "$(git -C "$checkout_root" status --porcelain --untracked-files=all)" ]] || {
    echo 'Error: capacity certification requires a clean checkout before candidate creation.' >&2
    exit 65
  }
  controller_command=(node "$controller_script" "${controller_args[@]}")
fi

data_template_dir="$(readlink -f -- "$data_template_dir")"
[[ -z "$(find "$data_template_dir" -type l -print -quit)" ]] || {
  echo 'Error: capacity data template must not contain symbolic links.' >&2
  exit 64
}
data_dir="$(readlink -m -- "$data_dir")"
if [[ "$profile" == 'final10k' ]]; then
  fault_data_dir="$(readlink -m -- "$fault_data_dir")"
  soak_data_dir="$(readlink -m -- "$soak_data_dir")"
  capacity_data_dirs=("$data_dir" "$fault_data_dir" "$soak_data_dir")
else
  capacity_data_dirs=("$data_dir")
fi

if [[ "${CASCADE_CAPACITY_TESTING:-0}" != '1' ]]; then
  [[ "$runner_source_database" = /* && -f "$runner_source_database" \
      && ! -L "$runner_source_database" \
      && "$(readlink -f -- "$runner_source_database")" == "$runner_source_database" ]] || {
    echo 'Error: controller --source-database must be a canonical regular file.' >&2
    exit 64
  }
  [[ "$runner_source_corpus_root" = /* && -d "$runner_source_corpus_root" \
      && ! -L "$runner_source_corpus_root" \
      && "$(readlink -f -- "$runner_source_corpus_root")" == "$runner_source_corpus_root" ]] || {
    echo 'Error: controller --source-corpus-root must be a canonical real directory.' >&2
    exit 64
  }
  [[ "$runner_fixture" = /* && -f "$runner_fixture" && ! -L "$runner_fixture" \
      && "$(readlink -f -- "$runner_fixture")" == "$runner_fixture" ]] || {
    echo 'Error: controller --fixture must be a canonical regular file.' >&2
    exit 64
  }
  [[ "$runner_results_dir" = /* && "$runner_results_dir" != '/' \
      && ! -e "$runner_results_dir" && ! -L "$runner_results_dir" \
      && -d "$(dirname -- "$runner_results_dir")" \
      && "$(readlink -f -- "$(dirname -- "$runner_results_dir")")" == "$(dirname -- "$runner_results_dir")" ]] || {
    echo 'Error: controller --results-dir must be a fresh canonical destination.' >&2
    exit 64
  }
  runner_results_dir="$(readlink -m -- "$runner_results_dir")"

  mutable_roots=("${capacity_data_dirs[@]}" "$runner_results_dir")
  immutable_directories=("$data_template_dir" "$runner_source_corpus_root" "$checkout_root")
  immutable_files=("$runner_source_database" "$runner_fixture")

  for left_root in "${mutable_roots[@]}"; do
    for right_root in "${mutable_roots[@]}"; do
      [[ "$left_root" == "$right_root" ]] && continue
      [[ "$right_root" != "$left_root"/* ]] || {
        echo 'Error: mutable capacity data/results roots must be pairwise disjoint and non-nested.' >&2
        exit 64
      }
    done
  done
  for mutable_root in "${mutable_roots[@]}"; do
    for immutable_directory in "${immutable_directories[@]}"; do
      [[ "$mutable_root" != "$immutable_directory" \
          && "$mutable_root" != "$immutable_directory"/* \
          && "$immutable_directory" != "$mutable_root"/* ]] || {
        echo 'Error: mutable capacity roots must be disjoint from immutable input directories.' >&2
        exit 64
      }
    done
    for immutable_file in "${immutable_files[@]}"; do
      [[ "$immutable_file" != "$mutable_root" && "$immutable_file" != "$mutable_root"/* ]] || {
        echo 'Error: immutable input files must be outside mutable capacity roots.' >&2
        exit 64
      }
    done
  done
  for left_directory in "${immutable_directories[@]}"; do
    for right_directory in "${immutable_directories[@]}"; do
      [[ "$left_directory" == "$right_directory" ]] && continue
      [[ "$right_directory" != "$left_directory"/* ]] || {
        echo 'Error: immutable input directories must not be nested.' >&2
        exit 64
      }
    done
    for immutable_file in "${immutable_files[@]}"; do
      [[ "$immutable_file" != "$left_directory"/* ]] || {
        echo 'Error: immutable input files must not be nested in immutable input directories.' >&2
        exit 64
      }
    done
  done
  [[ "$runner_source_database" != "$runner_fixture" ]] || {
    echo 'Error: source database and fixture inputs must be distinct.' >&2
    exit 64
  }
fi
declare -A capacity_roots_seen=()
for required_data_dir in "${capacity_data_dirs[@]}"; do
  [[ -n "$required_data_dir" && "$required_data_dir" != '/' \
      && -d "$(dirname -- "$required_data_dir")" ]] || {
    echo "Error: unsafe capacity data destination: $required_data_dir" >&2
    exit 64
  }
  [[ -z "${capacity_roots_seen[$required_data_dir]:-}" ]] || {
    echo 'Error: capacity phases must use pairwise-distinct data roots.' >&2
    exit 64
  }
  capacity_roots_seen[$required_data_dir]=1
done
for left_root in "${capacity_data_dirs[@]}"; do
  for right_root in "${capacity_data_dirs[@]}"; do
    [[ "$left_root" == "$right_root" ]] && continue
    [[ "$right_root" != "$left_root"/* ]] || {
      echo 'Error: capacity phase data roots must not be nested.' >&2
      exit 64
    }
  done
done

# This is deliberately one user-runtime-global path, not a checkout- or
# run-specific lock. The canonical mode-0700 runtime directory avoids the
# predictable /tmp check/open race. A test-only override keeps unit tests
# isolated without making the production entrypoint configurable into separate
# lock domains.
if [[ "${CASCADE_CAPACITY_TESTING:-0}" == '1' ]]; then
  lock_file="${CASCADE_CAPACITY_TEST_LOCK_FILE:?CASCADE_CAPACITY_TEST_LOCK_FILE is required in test mode}"
  runtime_dir="$(dirname -- "$lock_file")"
else
  runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  lock_file="$runtime_dir/cascade-elixir-capacity.lock"
fi
if [[ -L "$runtime_dir" || ! -d "$runtime_dir" || ! -O "$runtime_dir" \
    || "$(stat -c '%a' -- "$runtime_dir")" != '700' ]]; then
  echo "Error: capacity-run requires an owned mode-0700 runtime directory: $runtime_dir" >&2
  exit 73
fi

if [[ -L "$lock_file" || ( -e "$lock_file" && ! -f "$lock_file" ) ]]; then
  echo "Error: capacity-run lock is not a regular file: $lock_file" >&2
  exit 73
fi
umask 077
: >>"$lock_file"
if [[ ! -O "$lock_file" || "$(stat -c '%a' -- "$lock_file")" != '600' ]]; then
  echo "Error: capacity-run lock must be owned by this user with mode 0600: $lock_file" >&2
  exit 73
fi
exec {capacity_lock_fd}<>"$lock_file"
lock_path_identity="$(stat -Lc '%d:%i' -- "$lock_file")"
lock_fd_identity="$(stat -Lc '%d:%i' -- "/proc/$$/fd/$capacity_lock_fd")"
if [[ -L "$lock_file" || "$lock_path_identity" != "$lock_fd_identity" ]]; then
  echo 'Error: capacity-run lock identity changed while opening it.' >&2
  exit 73
fi
if ! flock -n "$capacity_lock_fd"; then
  echo 'Error: another capacity certification owns the host-wide lock; Docker was not touched.' >&2
  exit 75
fi

# The first Docker access happens only after the lock is held. Refuse any
# running canonical/suffixed capacity sibling or any controller-owned capacity
# container, including an older unwrapped run that never acquired this lock.
running_capacity="$(docker container ls --format \
  '{{.ID}}|{{.Names}}|{{.Label "io.cascade.capacity-run-owner"}}')"
while IFS='|' read -r running_id running_name running_owner; do
  [[ -n "$running_id" ]] || continue
  if [[ -n "$running_owner" || "$running_name" == 'cascade-elixir-capacity' \
      || "$running_name" == cascade-elixir-capacity-* ]]; then
    echo "Error: running capacity container $running_name is foreign state; refusing concurrent Docker mutation." >&2
    exit 73
  fi
done <<<"$running_capacity"

# Stopped phase names are foreign too. Use a successful all-container listing
# so a daemon/permission error cannot be mistaken for "not found".
all_containers="$(docker container ls -a --format '{{.ID}}|{{.Names}}')"
while IFS='|' read -r existing_id existing_name; do
  [[ -n "$existing_id" ]] || continue
  if [[ "$existing_name" == "$container" \
      || ( "$profile" == 'final10k' \
        && ( "$existing_name" == "$container-fault" || "$existing_name" == "$container-soak" ) ) ]]; then
    echo "Error: container $existing_name already exists; refusing to modify foreign capacity state." >&2
    exit 73
  fi
done <<<"$all_containers"

if [[ "${CASCADE_CAPACITY_TESTING:-0}" != '1' ]]; then
  image_reference="$image"
  [[ "$profile" == 'final10k' ]] && image_reference="$runner_image"
  if ! image_identity="$(docker image inspect "$image_reference" --format \
    '{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}')"; then
    echo "Error: capacity image $image_reference is unavailable." >&2
    exit 73
  fi
  IFS='|' read -r observed_image_id observed_revision <<<"$image_identity"
  [[ "$observed_image_id" == "$image" && "$observed_revision" == "$runner_revision" ]] || {
    echo 'Error: capacity image tag/ID/revision evidence does not match the requested clean checkout.' >&2
    exit 73
  }
fi

# Clone the same prepared production-derived fixture state independently for
# all three phases. Disable reflinks so the DBs have distinct storage/inodes;
# after the 10k freeze its root is never written again.
for required_data_dir in "${capacity_data_dirs[@]}"; do
  mkdir -m 700 -- "$required_data_dir"
  cp -a --reflink=never -- "$data_template_dir/." "$required_data_dir/"
done
declare -A capacity_database_inodes_seen=()
for required_data_dir in "${capacity_data_dirs[@]}"; do
  [[ -f "$required_data_dir/docs.db" && ! -L "$required_data_dir/docs.db" ]] || {
    echo "Error: cloned capacity data has no regular docs.db: $required_data_dir" >&2
    exit 70
  }
  database_inode="$(stat -Lc '%d:%i' -- "$required_data_dir/docs.db")"
  [[ -z "${capacity_database_inodes_seen[$database_inode]:-}" ]] || {
    echo 'Error: capacity phase databases do not have distinct device/inode identities.' >&2
    exit 70
  }
  capacity_database_inodes_seen[$database_inode]=1
done

run_owner="capacity-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
ownership_dir="$(mktemp -d "${TMPDIR:-/tmp}/cascade-capacity-owner.XXXXXXXX")"
owned_phases=()
declare -A phase_ids=()
declare -A phase_names=(
  [main10k]="$container"
  [faults]="$container-fault"
  [soak5k]="$container-soak"
  [diagnostic]="$container"
)
declare -A phase_roots=(
  [main10k]="$data_dir"
  [faults]="$fault_data_dir"
  [soak5k]="$soak_data_dir"
  [diagnostic]="$data_dir"
)
declare -A phase_owners=()
declare -A phase_cid_files=()
declare -A phase_created_at=()
declare -A phase_started_at=()
declare -A phase_stopped_at=()
declare -A phase_database_sha256=()
declare -A phase_database_device_inode=()
declare -A phase_database_frozen_at=()


source "$capacity_lib_dir/capacity-runtime.sh"
source "$capacity_lib_dir/capacity-phases.sh"
