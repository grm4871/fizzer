# Capacity preflight seam: establish and verify the generator CPU boundary before any Docker work.
# Failure mode: invalid affinity exits before lock acquisition or candidate mutation.
normalize_cpuset() {
  local spec="$1"
  local segment first last cpu
  local normalized=''
  local -a segments=()
  [[ "$spec" =~ ^[0-9]+(-[0-9]+)?(,[0-9]+(-[0-9]+)?)*$ ]] || return 1
  IFS=',' read -r -a segments <<<"$spec"
  for segment in "${segments[@]}"; do
    first="${segment%%-*}"
    last="${segment##*-}"
    (( first <= last )) || return 1
    for ((cpu = first; cpu <= last; cpu += 1)); do
      normalized+="${normalized:+,}${cpu}"
    done
  done
  printf '%s\n' "$normalized"
}

actual_cpuset="$(awk '$1 == "Cpus_allowed_list:" { print $2 }' /proc/self/status)"
available_cpus="$(normalize_cpuset "$actual_cpuset" || true)"
[[ -n "$available_cpus" ]] || {
  echo 'Error: could not read controller CPU affinity.' >&2
  exit 70
}

generator_cpuset="${CASCADE_CAPACITY_GENERATOR_CPUSET:-}"
if [[ -z "$generator_cpuset" ]]; then
  requested_cpus=''
  IFS=',' read -r -a available_cpu_list <<<"$available_cpus"
  for available_cpu in "${available_cpu_list[@]}"; do
    if (( available_cpu > 1 )); then
      requested_cpus+="${requested_cpus:+,}${available_cpu}"
    fi
  done
  generator_cpuset="$requested_cpus"
else
  requested_cpus="$(normalize_cpuset "$generator_cpuset" || true)"
fi
[[ -n "$requested_cpus" ]] || {
  echo 'Error: capacity certification requires valid generator CPUs outside 0-1.' >&2
  exit 69
}
case ",$requested_cpus," in
  *,0,*|*,1,*)
    echo 'Error: generator/controller CPU affinity must exclude candidate CPUs 0-1.' >&2
    exit 64
    ;;
esac
command -v taskset >/dev/null 2>&1 || {
  echo 'Error: taskset is required to isolate capacity generators.' >&2
  exit 69
}
actual_cpus="$available_cpus"
if [[ "$actual_cpus" != "$requested_cpus" && "${CASCADE_CAPACITY_AFFINITY_BOUND:-0}" != '1' ]]; then
  export CASCADE_CAPACITY_AFFINITY_BOUND=1
  export CASCADE_CAPACITY_GENERATOR_CPUSET="$generator_cpuset"
  exec taskset -c "$generator_cpuset" bash "$(readlink -f -- "$0")" "${original_args[@]}"
fi
if [[ "$actual_cpus" != "$requested_cpus" ]]; then
  echo "Error: controller affinity $actual_cpuset does not match requested generator CPUs $generator_cpuset." >&2
  exit 70
fi
export CASCADE_CAPACITY_AFFINITY_BOUND=1
export CASCADE_CAPACITY_GENERATOR_CPUSET="$generator_cpuset"
