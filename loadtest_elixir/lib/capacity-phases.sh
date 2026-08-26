# Capacity phase seam: ordered candidate lifecycle and controller invocations.
# Failure mode: every phase verifies its frozen database before the next candidate starts.
if [[ "$profile" == 'diagnostic1k' ]]; then
  create_candidate diagnostic
  invoke_controller diagnostic preflight-diagnostic "${controller_command[@]}"
  verify_never_started diagnostic || {
    echo 'Error: diagnostic preflight mutated the never-started container.' >&2
    exit 70
  }
  start_candidate diagnostic
  invoke_controller diagnostic run-diagnostic "${controller_command[@]}"
  stop_candidate diagnostic
  freeze_phase_database diagnostic
  invoke_controller diagnostic freeze-diagnostic "${controller_command[@]}"
  assert_phase_database_frozen diagnostic
  exit 0
fi

create_candidate main10k
invoke_controller main10k preflight-main10k "${controller_command[@]}"
verify_never_started main10k || {
  echo 'Error: main10k preflight mutated the never-started container.' >&2
  exit 70
}
start_candidate main10k
invoke_controller main10k run-main10k "${controller_command[@]}"
stop_candidate main10k
freeze_phase_database main10k
invoke_controller main10k reconcile-main10k "${controller_command[@]}"
assert_phase_database_frozen main10k

create_candidate faults
invoke_controller faults preflight-faults "${controller_command[@]}"
verify_never_started faults || {
  echo 'Error: faults preflight mutated the never-started container.' >&2
  exit 70
}
start_candidate faults
invoke_controller faults run-faults "${controller_command[@]}"
stop_candidate faults
freeze_phase_database faults
invoke_controller faults freeze-faults "${controller_command[@]}"
assert_phase_database_frozen main10k
assert_phase_database_frozen faults

create_candidate soak5k
invoke_controller soak5k preflight-soak5k "${controller_command[@]}"
verify_never_started soak5k || {
  echo 'Error: soak5k preflight mutated the never-started container.' >&2
  exit 70
}
start_candidate soak5k
invoke_controller soak5k run-soak5k "${controller_command[@]}"
stop_candidate soak5k
freeze_phase_database soak5k
invoke_controller soak5k freeze-soak5k "${controller_command[@]}"
assert_phase_database_frozen main10k
assert_phase_database_frozen faults
assert_phase_database_frozen soak5k

invoke_controller main10k certify "${controller_command[@]}"
assert_phase_database_frozen main10k
assert_phase_database_frozen faults
assert_phase_database_frozen soak5k
