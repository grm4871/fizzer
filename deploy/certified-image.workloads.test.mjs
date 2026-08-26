import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import * as fixtureModule from './lib/certified-test-fixtures.mjs';
import * as soakFixtureModule from './lib/certified-test-fixtures-soak.mjs';
import * as certified from './certified-image.mjs';
import { loadConfiguration } from '../loadtest_elixir/load.mjs';
import { RETURN_THRESHOLDS, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, evaluateSoakEvidence as evaluateLongSoakEvidence, parseSoakJournal, recomputeSoakJournal } from '../loadtest_elixir/soak-invariants.mjs';

const { deployDirectory, root, imageId, revision, monitorDigest, runtimeShape, releaseThresholds, artifact, faultArtifact, faultResult, soakArtifact, stable, fakeJwt, sha256, productionSourceSummary, capacityFixtureArtifact, monitor, monitorEndpoints, loadShard } = fixtureModule;
const { soakFixtureArtifact, soakServerLogArtifact, soakDatabaseEvidence, soakSample, soakFixtureEvidence, soakResult } = soakFixtureModule;
const { PRODUCTION_APPLICATION_TABLES, compareProductionRows, compareCorpusTree, configureSnapshotScratch, phaseWorkloadEvidence, validateBaselineOrphanState, validateCapacityFixtureArtifact, validateCapacityFixtureSummary, validateFaultEvidence, validateFaultPersistence, validateFixturePreflight, validateFreezeEvidence, validateLoadEvidence, validateLoadProvenance, validateManifest, validateMonitorEvidence, validatePhaseTableDeltas, validatePhaseChronology, validateProductionSourceSummary, validateReconciliationEvidence, validateServerLogArtifact, validateSoakEvidence } = certified;


test('rejects monitor duration, concurrency window, or finish coverage below the release contract', () => {
  const tooShort = monitor();
  tooShort[0].monitorConfig.durationSeconds = 2_249;
  assert.throws(() => validateMonitorEvidence(tooShort, imageId), /shorter than 2,250 seconds/);

  const shortGate = monitor();
  shortGate[0].monitorConfig.gateWindowSeconds = 1_799;
  assert.throws(() => validateMonitorEvidence(shortGate, imageId), /shorter than 30 minutes/);

  const missingCoverage = monitor();
  delete missingCoverage.at(-1).evaluation.observed.membershipCoverage;
  assert.throws(() => validateMonitorEvidence(missingCoverage, imageId), /50,000-membership coverage/);

  const staleMarker = monitor();
  staleMarker.at(-1).workload.finishedAt = '2026-08-10T23:59:59.000Z';
  assert.throws(() => validateMonitorEvidence(staleMarker, imageId), /stale or invalid/);

  const identityDrift = monitor();
  identityDrift[1].containerState.imageId = `sha256:${'d'.repeat(64)}`;
  assert.throws(() => validateMonitorEvidence(identityDrift, imageId), /identity drifted/);

  const finishDrift = monitor();
  finishDrift.at(-1).containerState.containerId = 'replacement-container';
  assert.throws(() => validateMonitorEvidence(finishDrift, imageId), /finish container\/image identity differs/);

  const resourceDrift = monitor();
  resourceDrift[1].containerState.memory = 4 * 1024 ** 3;
  assert.throws(() => validateMonitorEvidence(resourceDrift, imageId), /runtime envelope drifted/);
});

test('rejects missing, drifted, or nonzero server-log evidence', () => {
  const missing = monitor();
  delete missing.at(-1).serverLogs;
  assert.throws(() => validateMonitorEvidence(missing, imageId), /server-log artifact path|server-log capture/);

  const drifted = monitor();
  drifted.at(-1).serverLogs.baselineCursor = '2026-08-11T00:00:01.000Z';
  assert.throws(() => validateMonitorEvidence(drifted, imageId), /server-log capture interval/);

  const errored = monitor();
  errored.at(-1).serverLogs.matchedErrorLines = 1;
  errored.at(-1).serverLogs.matches = ['[error] crash'];
  assert.throws(() => validateMonitorEvidence(errored, imageId), /contains fatal\/error lines/);
});

test('server-log certification binds one regular raw artifact snapshot', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-server-log-cert-'));
  try {
    const output = path.join(directory, 'server.log');
    const raw = '2026-08-11T00:00:00Z [info] started\n';
    fs.writeFileSync(output, raw, { mode: 0o600 });
    const [start, finish] = monitorEndpoints();
    start.serverLogEvidence.output = output;
    Object.assign(finish.serverLogs, {
      output,
      sha256: createHash('sha256').update(raw).digest('hex'),
      totalBytes: Buffer.byteLength(raw),
      totalLines: 1,
    });
    assert.equal(validateServerLogArtifact(start, finish).path, output);

    fs.appendFileSync(output, 'tampered\n');
    assert.throws(() => validateServerLogArtifact(start, finish), /checksum differs/);

    fs.unlinkSync(output);
    const target = path.join(directory, 'target.log');
    fs.writeFileSync(target, raw);
    fs.symlinkSync(target, output);
    assert.throws(() => validateServerLogArtifact(start, finish), /without following symlinks/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects reconnect, ramp, or soak evidence below the release contract', () => {
  const [start, finish] = monitorEndpoints();
  const short = [0, 1, 2, 3].map(loadShard);
  short[2].soakSeconds = 1_859;
  assert.throws(() => validateLoadEvidence(short, start, finish, [0, 1, 2, 3].map(artifact)),
    /inconsistent workload configurations|differs from the monitor workload contract/);

  const incomplete = [0, 1, 2, 3].map(loadShard);
  incomplete[1].metrics.forcedReconnectsWithin20s = 249;
  assert.throws(() => validateLoadEvidence(incomplete, start, finish, [0, 1, 2, 3].map(artifact)),
    /20-second reconnect deadline/);

  const drifted = [0, 1, 2, 3].map(loadShard);
  drifted[3].target = 'https://different.example';
  assert.throws(() => validateLoadEvidence(drifted, start, finish, [0, 1, 2, 3].map(artifact)),
    /different staging endpoints/);

  const ownerIdsDrifted = [0, 1, 2, 3].map(loadShard);
  ownerIdsDrifted[0].selectionPlan.forcedReconnectOwnerUserIds.pop();
  assert.throws(() => validateLoadEvidence(
    ownerIdsDrifted,
    start,
    finish,
    [0, 1, 2, 3].map(artifact),
  ), /presence-owner plan differs/);
});

test('requires every shard artifact and ready interval to cover the exact monitor gate', () => {
  const [start, finish] = monitorEndpoints();
  const late = [0, 1, 2, 3].map(loadShard);
  late[2].soakStartedAt = '2026-08-11T00:06:01.000Z';
  assert.throws(() => validateLoadEvidence(late, start, finish, [0, 1, 2, 3].map(artifact)),
    /not ready before the monitor gate started/);

  const early = [0, 1, 2, 3].map(loadShard);
  early[0].workloadFinishedAt = '2026-08-11T00:35:59.000Z';
  assert.throws(() => validateLoadEvidence(early, start, finish, [0, 1, 2, 3].map(artifact)),
    /ended before the monitor gate finished/);

  const changedArtifact = [0, 1, 2, 3].map(artifact);
  changedArtifact[1] = { ...changedArtifact[1], sha256: 'f'.repeat(64) };
  assert.throws(() => validateLoadEvidence(
    [0, 1, 2, 3].map(loadShard), start, finish, changedArtifact,
  ), /checksum differs from the workload marker/);
});

test('fault certification binds runner restart and SQLite lock recovery to the exact image', () => {
  const results = [faultResult('runner-restart-reclaim'), faultResult('sqlite-write-lock')];
  const artifacts = [faultArtifact(0), faultArtifact(1)];
  assert.equal(
    validateFaultEvidence(results, artifacts, imageId, revision, 'https://staging.example', 'e'.repeat(64)).length,
    2,
  );
  assert.throws(
    () => validateFaultEvidence(
      [results[0], { ...results[1], imageId: `sha256:${'f'.repeat(64)}` }],
      artifacts,
      imageId,
      revision,
      'https://staging.example',
      'e'.repeat(64),
    ),
    /different image/,
  );
  assert.throws(
    () => validateFaultEvidence(
      [results[0], { ...results[1], observations: { ...results[1].observations, failedWriteAbsent: false } }],
      artifacts,
      imageId,
      revision,
      'https://staging.example',
      'e'.repeat(64),
    ),
    /phantom failure/,
  );
  const wrongFixture = structuredClone(results);
  wrongFixture[1].fixtureSha256 = '0'.repeat(64);
  assert.throws(
    () => validateFaultEvidence(
      wrongFixture, artifacts, imageId, revision, 'https://staging.example', 'e'.repeat(64),
    ),
    /different authenticated fixture cohort/,
  );
});

test('phase chronology binds each never-started preflight before its workload', () => {
  const preflights = {
    faults: { createdAt: '2026-08-11T01:01:00.000Z' },
    soak5k: { createdAt: '2026-08-11T01:02:00.000Z' },
  };
  const freezes = {
    main10k: { frozenAt: '2026-08-11T01:00:00.000Z' },
    faults: { frozenAt: '2026-08-11T01:10:00.000Z' },
    soak5k: { frozenAt: '2026-08-11T04:00:00.000Z' },
  };
  const reconciliation = { finishedAt: '2026-08-11T00:59:00.000Z' };
  const faults = [
    { startedAt: '2026-08-11T01:03:00.000Z', finishedAt: '2026-08-11T01:04:00.000Z' },
    { startedAt: '2026-08-11T01:04:00.000Z', finishedAt: '2026-08-11T01:05:00.000Z' },
  ];
  const soak = { startedAt: '2026-08-11T01:03:00.000Z', finishedAt: '2026-08-11T03:30:00.000Z' };
  assert.equal(validatePhaseChronology(preflights, freezes, reconciliation, faults, soak), true);
  assert.throws(() => validatePhaseChronology(
    { ...preflights, faults: { createdAt: '2026-08-11T01:04:30.000Z' } },
    freezes, reconciliation, faults, soak,
  ), /before its never-started preflight/);
  assert.throws(() => validatePhaseChronology(
    { ...preflights, soak5k: { createdAt: '2026-08-11T01:04:00.000Z' } },
    freezes, reconciliation, faults, soak,
  ), /before its never-started preflight/);
});

test('soak certification binds two hours, 5,000 users, churn, run events, and recovery journal', () => {
  const { result, journal, fixture, serverLog } = soakResult();
  const validated = validateSoakEvidence(
    result,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  assert.equal(validated.users, 5_000);
  assert.equal(validated.soakSeconds, 7_200);
  assert.equal(validated.evaluation, 'passed');
  assert.throws(
    () => validateSoakEvidence(
      { ...result, expectedImage: `sha256:${'f'.repeat(64)}` },
      soakArtifact(),
      journal,
      fixture,
      serverLog,
      imageId,
      revision,
      'https://staging.example',
    ),
    /different image/,
  );
  assert.throws(
    () => validateSoakEvidence(
      { ...result, workload: { ...result.workload, initialConnected: 4_999 } },
      soakArtifact(),
      journal,
      fixture,
      serverLog,
      imageId,
      revision,
      'https://staging.example',
    ),
    /5,000 authenticated runner users/,
  );
});

test('soak certifier recomputes raw journal, fixture, run-ID, log, profile, and cleanup evidence', () => {
  const validate = (result, journal, fixture, serverLog) => validateSoakEvidence(
    result,
    soakArtifact(),
    journal,
    fixture,
    serverLog,
    imageId,
    revision,
    'https://staging.example',
  );
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const records = journal.text.trim().split('\n').map(JSON.parse);
    records[10].containerState.hostConfig.memory = 4 * 1024 ** 3;
    const drifted = { ...journal, text: `${records.map(JSON.stringify).join('\n')}\n` };
    assert.throws(() => validate(result, drifted, fixture, serverLog), /aggregates differ|recomputed evidence/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[0]);
    changed.vaultId = 'wrong-vault';
    rows[0] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /fixture vault\/channel group .* owns 0 chat channels/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[0]);
    delete changed.ownedChatChannels;
    rows[0] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /fixture line 1 is incomplete/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    const rows = fixture.text.trim().split('\n');
    const changed = JSON.parse(rows[1]);
    changed.ownedChatChannels = 1;
    rows[1] = JSON.stringify(changed);
    assert.throws(
      () => validate(result, journal, { ...fixture, text: `${rows.join('\n')}\n` }, serverLog),
      /owns 2 chat channels, expected exactly 1/,
    );
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.workload.runIds.terminal.pop();
    assert.throws(() => validate(result, journal, fixture, serverLog), /run-ID sets differ/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    assert.throws(() => validate(result, journal, fixture, { ...serverLog, text: '[error] ok\n' }), /contains errors|recomputed analysis/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.profile.sampleIntervalSeconds = 30;
    assert.throws(() => validate(result, journal, fixture, serverLog), /workload profile/);
  }
  {
    const { result, journal, fixture, serverLog } = soakResult();
    result.probe.uninstallError = 'timed out';
    result.evaluation = evaluateLongSoakEvidence(result);
    assert.throws(() => validate(result, journal, fixture, serverLog), /evaluation failed|recomputed evidence/);
  }
});

