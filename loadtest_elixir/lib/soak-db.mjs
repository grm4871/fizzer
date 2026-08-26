import { sortedNumeric, bearer, digest, stableJson, parseLastJson, releaseRpc, BASELINE_ORPHANS, BASELINE_ORPHAN_RECLAIM_SUMMARY } from './soak-inputs.mjs';
import { mapConcurrent, jsonRequest, persistedEventFailures } from './soak-client.mjs';

/**
 * Soak database seam: persisted run/event reconciliation and teardown counters.
 * Evidence invariant: persisted IDs and event signatures must exactly match live workload identity.
 */
export async function reconcilePersistedRuns(target, metrics) {
  const requested = sortedNumeric(metrics.requestedRunIds);
  const failures = [];
  const rows = await mapConcurrent(requested, 32, async (runId) => {
    const fixture = metrics.runOwners.get(runId);
    if (!fixture) return { runId, failures: [`run ${runId} has no fixture owner`] };
    try {
      const [runBody, eventBody] = await Promise.all([
        jsonRequest(`${target}/api/runs/${runId}`, { headers: bearer(fixture.token) }),
        jsonRequest(`${target}/api/runs/${runId}/events`, { headers: bearer(fixture.token) }),
      ]);
      const run = runBody?.run;
      const events = eventBody?.events;
      const rowFailures = [];
      if (Number(run?.id) !== runId || String(run?.vault_id) !== String(fixture.vaultId)) rowFailures.push(`run ${runId} persisted in the wrong vault`);
      if (run?.status !== 'completed') rowFailures.push(`run ${runId} persisted status is ${run?.status || 'missing'}`);
      const eventResult = persistedEventFailures(runId, events);
      rowFailures.push(...eventResult.failures);
      return { runId, status: run?.status, eventCount: eventResult.eventCount, signature: eventResult.signature, failures: rowFailures };
    } catch (error) {
      return { runId, failures: [`run ${runId} reconciliation failed: ${error.message}`] };
    }
  });
  for (const row of rows) failures.push(...row.failures);
  const persisted = rows.filter((row) => row.status === 'completed' && row.failures.length === 0).map((row) => row.runId);
  return {
    runs: rows.length,
    completed: rows.filter((row) => row.status === 'completed').length,
    eventsReconciled: rows.filter((row) => row.eventCount > 0 && row.failures.length === 0).length,
    totalEvents: rows.reduce((total, row) => total + (row.eventCount || 0), 0),
    runIds: persisted,
    eventDigest: digest(stableJson(rows.map(({ failures: _failures, ...row }) => row))),
    failures,
  };
}

export function databaseSnapshot(container) {
  return parseLastJson(releaseRpc(
    container,
    'scalar = fn sql -> case Cascade.Accounts.SQL.one(sql) do [value] -> value; _ -> nil end end; orphans = Cascade.Accounts.SQL.all("SELECT r.id,r.status,r.summary,d.owner_user_id,(SELECT max(seq) FROM run_events e WHERE e.run_id=r.id),(SELECT type FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1),(SELECT payload_json FROM run_events e WHERE e.run_id=r.id ORDER BY seq DESC LIMIT 1) FROM runs r LEFT JOIN delegated_runs d ON d.run_id=r.id WHERE r.id IN (1896,1897) ORDER BY r.id") |> Enum.map(fn [id,status,summary,owner_user_id,max_seq,last_type,last_payload] -> %{id: id,status: status,summary: summary,ownerUserId: owner_user_id,maxSeq: max_seq,lastType: last_type,lastPayload: last_payload} end); Jason.encode!(%{users: scalar.("SELECT count(*) FROM users"), vaults: scalar.("SELECT count(*) FROM vaults"), memberships: scalar.("SELECT count(*) FROM vault_members"), runs: scalar.("SELECT count(*) FROM runs"), runEvents: scalar.("SELECT count(*) FROM run_events"), delegatedRuns: scalar.("SELECT count(*) FROM delegated_runs"), baselineOrphans: orphans, foreignKeyViolations: scalar.("SELECT count(*) FROM pragma_foreign_key_check"), quickCheck: scalar.("SELECT group_concat(quick_check, \'\') FROM pragma_quick_check")}) |> IO.puts()',
  ));
}

export function parsePayload(payload) {
  try { return JSON.parse(payload); } catch { return null; }
}

export function baselineOrphanFailures(baseline, final) {
  const failures = [];
  if (!Array.isArray(baseline?.baselineOrphans)
      || baseline.baselineOrphans.length !== BASELINE_ORPHANS.length) {
    failures.push('database baseline does not contain the two approved queued delegated runs');
    return failures;
  }
  if (!Array.isArray(final?.baselineOrphans)
      || final.baselineOrphans.length !== BASELINE_ORPHANS.length) {
    failures.push('database final state does not contain the two approved orphaned runs');
    return failures;
  }
  for (const expected of BASELINE_ORPHANS) {
    const before = baseline.baselineOrphans.find((row) => row.id === expected.id);
    const after = final.baselineOrphans.find((row) => row.id === expected.id);
    if (!before || before.status !== 'queued' || before.summary != null
        || before.ownerUserId !== expected.ownerUserId || before.maxSeq !== expected.queuedSeq) {
      failures.push(`database baseline orphan run ${expected.id} is not the exact queued delegation`);
    }
    const payload = parsePayload(after?.lastPayload);
    if (!after || after.status !== 'failed' || after.summary !== BASELINE_ORPHAN_RECLAIM_SUMMARY
        || after.ownerUserId != null || after.maxSeq !== expected.failedSeq
        || after.lastType !== 'status'
        || stableJson(payload) !== stableJson({
          status: 'failed', summary: BASELINE_ORPHAN_RECLAIM_SUMMARY,
        })) {
      failures.push(`database final orphan run ${expected.id} lacks the exact reclaim terminal event`);
    }
  }
  return failures;
}

export function databaseReconciliation(baseline, final, runs, totalEvents) {
  const failures = [];
  for (const key of ['users', 'vaults', 'memberships']) {
    if (!Number.isInteger(baseline?.[key]) || final?.[key] !== baseline[key]) {
      failures.push(`database ${key} changed from ${baseline?.[key] ?? 'missing'} to ${final?.[key] ?? 'missing'}`);
    }
  }
  if (final?.runs - baseline?.runs !== runs) failures.push(`database run delta is ${final?.runs - baseline?.runs}, expected ${runs}`);
  if (baseline?.delegatedRuns !== BASELINE_ORPHANS.length || final?.delegatedRuns !== 0) {
    failures.push(`database delegated-run transition is ${baseline?.delegatedRuns ?? 'missing'} to ${final?.delegatedRuns ?? 'missing'}, expected 2 to 0`);
  }
  if (final?.runEvents - baseline?.runEvents !== totalEvents + BASELINE_ORPHANS.length) {
    failures.push(`database run-event delta is ${final?.runEvents - baseline?.runEvents}, expected ${totalEvents + BASELINE_ORPHANS.length}`);
  }
  failures.push(...baselineOrphanFailures(baseline, final));
  if (final?.foreignKeyViolations !== 0) failures.push(`${final?.foreignKeyViolations ?? 'missing'} SQLite foreign-key violations`);
  if (final?.quickCheck !== 'ok') failures.push(`SQLite quick_check is ${final?.quickCheck ?? 'missing'}, expected ok`);
  return { baseline, final, failures };
}

export function probeMetricCount(snapshot, name) {
  const metric = snapshot?.metrics?.[name];
  return typeof metric === 'number' ? metric : metric?.count || 0;
}

export function teardownProbeEvidence(before, summary) {
  const after = summary?.snapshot;
  const delta = (name) => probeMetricCount(after, name) - probeMetricCount(before, name);
  return {
    runnerDisconnectFlushes: delta('runner_disconnect_flushes'),
    runnerDisconnectFlushOwners: delta('runner_disconnect_flush_owners'),
    runnerDelegatedSnapshotReads: delta('runner_delegated_snapshot_reads'),
    runnerDelegatedOwnerReads: delta('runner_delegated_owner_reads'),
    presenceDispatcher: after?.deep?.presenceDispatcher || null,
  };
}
