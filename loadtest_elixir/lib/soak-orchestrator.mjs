import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readFixtures } from '../load.mjs';
import { analyzeServerLogs, headroomEvaluation, serverLogFailures, shapeFailures } from '../monitor.mjs';
import { PRODUCTION_CPUS, PRODUCTION_MEMORY_BYTES, SOAK_MEMBERSHIPS, SOAK_FIXTURE_GROUP_SIZE, SOAK_FIXTURE_GROUPS, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, RETURN_THRESHOLDS, command, docker, releaseRpc, parseLastJson, sleep, sha256File, digest, stableJson, exactRuntimeFailures, currentIdentity, runtimeIdentity, referenceVector } from './soak-inputs.mjs';
import { recomputeSoakJournal, parseSoakJournal, evaluateSoakEvidence } from './soak-evaluator.mjs';
import { attachClient, waitForReady, jsonRequest, captureSample, fixtureEvidence, captureServerLogs } from './soak-client.mjs';
import { reconcilePersistedRuns, databaseSnapshot, databaseReconciliation, teardownProbeEvidence } from './soak-db.mjs';

/**
 * Soak orchestrator seam: ramp/churn timing, probe lifecycle, journal, and final artifact.
 * Failure mode: cleanup always attempts probe uninstall while preserving interrupted evidence.
 */
export async function runMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const target = String(args.target || '').replace(/\/$/u, '');
  const fixturesFile = path.resolve(String(args.fixtures || ''));
  const container = String(args.container || '');
  const output = path.resolve(String(args.output || ''));
  const expectedImage = String(args.expectedImage || '');
  const expectedRevision = String(args.expectedRevision || '');
  if (!target || !args.fixtures || !container || !args.output || !expectedImage || !expectedRevision) {
    throw new Error('--target, --fixtures, --container, --output, --expected-image, and --expected-revision are required');
  }
  for (const [key, expected] of Object.entries(SOAK_PROFILE)) {
    if (args[key] != null && Number(args[key]) !== expected) {
      throw new Error(`--${key} is fixed at ${expected} for release certification`);
    }
  }
  const profile = { ...SOAK_PROFILE };
  const sourceIp = String(args.sourceIp || '');
  const journalFile = `${output}.samples.jsonl`;
  const serverLogFile = `${output}.container.log`;
  if (fs.existsSync(output) || fs.existsSync(journalFile) || fs.existsSync(serverLogFile)) {
    throw new Error(`output, sample journal, or server-log artifact already exists: ${output}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const fixtures = readFixtures(fixturesFile, { users: profile.users });
  if (fixtures.length !== profile.users) throw new Error(`fixtures contain ${fixtures.length}/${profile.users} selected users`);
  if (fixtures.some((fixture) => fixture.runner !== true)) throw new Error('every two-hour soak fixture must enable a desktop runner');
  const fixtureArtifact = fixtureEvidence(fixturesFile, fixtures);
  if (fixtureArtifact.groups !== SOAK_FIXTURE_GROUPS
      || fixtureArtifact.groupIdentities.some((group) => (
        group.users !== SOAK_FIXTURE_GROUP_SIZE || group.owners !== 1
      ))) {
    throw new Error(`fixtures must contain exactly ${SOAK_FIXTURE_GROUPS} complete ${SOAK_FIXTURE_GROUP_SIZE}-user vault/channel groups with one owner each`);
  }

  const identity = { initial: currentIdentity(container), final: null, runtimeInitial: null, runtimeFinal: null };
  const preflightFailures = shapeFailures(identity.initial.rawHostConfig, PRODUCTION_CPUS, PRODUCTION_MEMORY_BYTES);
  if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImage)) preflightFailures.push('--expected-image must be an immutable sha256 image ID');
  if (identity.initial.container.imageId !== expectedImage) preflightFailures.push(`running image ${identity.initial.container.imageId} does not match ${expectedImage}`);
  if (!identity.initial.container.running) preflightFailures.push('candidate container is not running');
  if (identity.initial.container.restartCount !== 0) preflightFailures.push('candidate container restart count is not zero');
  if (identity.initial.container.oomKilled) preflightFailures.push('candidate container was OOM-killed');
  preflightFailures.push(...exactRuntimeFailures(runtimeIdentity(container)));
  if (!/^[a-f0-9]{40}$/u.test(expectedRevision)) preflightFailures.push('--expected-revision must be a full 40-character Git revision');
  if (identity.initial.image.revision !== expectedRevision) preflightFailures.push(`running image revision ${identity.initial.image.revision || 'missing'} does not match ${expectedRevision}`);
  if (preflightFailures.length) throw new Error(`soak preflight failed: ${preflightFailures.join('; ')}`);
  const cleanupTasks = [];
  const contexts = [];
  let probeInstalled = false;
  cleanupTasks.push(() => {
    for (const context of contexts) {
      context.closing = true;
      context.manager.disconnect();
    }
  });
  try {
  fs.writeFileSync(journalFile, '', { flag: 'wx', mode: 0o600 });
  const probePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'capacity_probe.exs');
  const probeSha256 = sha256File(probePath);
  const probeLibrary = path.join(path.dirname(probePath), 'lib');
  const probeModules = ['capacity_probe_metrics.exs', 'capacity_probe_server.exs'];
  if (!probeModules.every((name) => fs.existsSync(path.join(probeLibrary, name)))) {
    throw new Error(`capacity probe support modules not found: ${probeLibrary}`);
  }
  docker('exec', container, 'mkdir', '-p', '/tmp/lib');
  docker('cp', probePath, `${container}:/tmp/cascade-soak-probe.exs`);
  for (const module of probeModules) {
    docker('cp', path.join(probeLibrary, module), `${container}:/tmp/lib/${module}`);
  }
  const priorProbe = parseLastJson(releaseRpc(
    container,
    'snapshot = if Code.ensure_loaded?(CascadeCapacityProbe), do: CascadeCapacityProbe.snapshot(), else: %{error: "capacity probe is not installed"}; Jason.encode!(snapshot) |> IO.puts()',
  ));
  const ownsProbe = priorProbe?.error === 'capacity probe is not installed';
  if (!ownsProbe) throw new Error('capacity probe was already installed; counters are not isolated to this soak');
  parseLastJson(releaseRpc(
    container,
    'Code.eval_file("/tmp/cascade-soak-probe.exs"); {:ok, snapshot} = CascadeCapacityProbe.install(); Jason.encode!(snapshot) |> IO.puts()',
  ));
  probeInstalled = true;
  cleanupTasks.push(() => {
    if (probeInstalled) {
      parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()'));
      const post = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
      if (post?.error !== 'capacity probe is not installed') throw new Error('capacity probe remained installed after cleanup');
      probeInstalled = false;
    }
  });
  identity.runtimeInitial = runtimeIdentity(container);

  const runtimeSampleFailures = [];
  let priorCpu = null;
  const appendSample = async (phase, elapsedSeconds = 0) => {
    const captured = await captureSample(container, identity.initial, phase, elapsedSeconds, priorCpu);
    const sample = captured.sample;
    priorCpu = captured.cpu;
    runtimeSampleFailures.push(...sample.errors.map((error) => `${phase} runtime sample: ${error}`));
    fs.appendFileSync(journalFile, `${JSON.stringify(sample)}\n`);
    return sample;
  };
  await sleep(11_000);
  const baselineSamples = [];
  for (let index = 0; index < 3; index += 1) {
    baselineSamples.push(await appendSample('baseline'));
    if (index < 2) await sleep(profile.sampleIntervalSeconds * 1_000);
  }
  const baselineReference = referenceVector(baselineSamples);
  const databaseBaseline = databaseSnapshot(container);

  const metrics = {
    runs: { scheduled: 0, created: 0, delegated: 0, completed: 0, duplicates: 0, orderingViolations: 0, requestErrors: 0 },
    requestedRunIds: new Set(),
    delegatedRunIds: new Set(),
    terminalRunIds: new Set(),
    lastRunSeq: new Map(),
    liveEvents: new Map(),
    runOwners: new Map(),
  };
  let stopping = false;
  let interruptedSignal = '';
  const requestStop = (signal) => {
    interruptedSignal = signal;
    stopping = true;
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  cleanupTasks.push(() => {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  });
  let initialConnectionFailures = 0;
  const rampDelayMs = profile.users > 1 ? profile.rampSeconds * 1_000 / (profile.users - 1) : 0;
  const rampStartedAt = new Date().toISOString();
  const rampStarted = performance.now();
  for (let index = 0; index < fixtures.length; index += 1) {
    if (stopping) break;
    const scheduledAt = rampStarted + index * rampDelayMs;
    const untilScheduled = scheduledAt - performance.now();
    if (untilScheduled > 0) await sleep(untilScheduled);
    const context = attachClient(target, fixtures[index], index, sourceIp, metrics);
    contexts.push(context);
    context.manager.open();
    context.vault.connect();
    context.runs.connect();
    context.runner.connect();
    try { await waitForReady(context, 1, 20_000); } catch { initialConnectionFailures += 1; }
  }
  let remainingRamp = rampStarted + profile.rampSeconds * 1_000 - performance.now();
  while (remainingRamp > 0) {
    await sleep(remainingRamp);
    remainingRamp = rampStarted + profile.rampSeconds * 1_000 - performance.now();
  }
  const rampCompletedAt = new Date().toISOString();

  const connectedContexts = contexts.filter((context) => (
    context.vault.connected && context.runs.connected && context.runner.connected
  ));
  const churnCycles = [];
  const inFlightRuns = new Set();
  let nextRunner = 0;
  let churnRunning = false;
  const soakStartedAt = new Date().toISOString();
  const soakStarted = performance.now();
  await appendSample('soak', 0);
  let sampleChain = Promise.resolve();
  const sampleTimer = setInterval(() => {
    sampleChain = sampleChain
      .then(() => appendSample('soak', (performance.now() - soakStarted) / 1_000))
      .catch((error) => preflightFailures.push(`runtime sample failed: ${error.message}`));
  }, profile.sampleIntervalSeconds * 1_000);
  cleanupTasks.push(() => clearInterval(sampleTimer));

  const runIntervalMs = Math.max(1, 1_000 / profile.runRps);
  const runTimer = setInterval(() => {
    if (stopping) return;
    metrics.runs.scheduled += 1;
    const task = (async () => {
      let context = null;
      for (let attempts = 0; attempts < connectedContexts.length; attempts += 1) {
        const candidate = connectedContexts[nextRunner++ % connectedContexts.length];
        if (candidate?.runner.connected && candidate.runs.connected && candidate.activeRunIds.size === 0) {
          context = candidate;
          break;
        }
      }
      if (!context) {
        metrics.runs.requestErrors += 1;
        return;
      }
      try {
        const data = await jsonRequest(
          `${target}/api/vaults/${encodeURIComponent(context.fixture.vaultId)}/runs`,
          {
            method: 'POST',
            headers: bearer(context.fixture.token, sourceIp),
            body: JSON.stringify({ prompt: 'two-hour soak invariant proof', agent: 'grok', note_id: null }),
          },
        );
        const runId = Number(data?.run?.id);
        if (!Number.isFinite(runId)) throw new Error('run response has no numeric ID');
        metrics.runs.created += 1;
        metrics.requestedRunIds.add(runId);
        metrics.runOwners.set(runId, context.fixture);
        context.activeRunIds.add(runId);
        context.runs.emit('joinRun', runId);
      } catch {
        metrics.runs.requestErrors += 1;
      }
    })().finally(() => inFlightRuns.delete(task));
    inFlightRuns.add(task);
  }, runIntervalMs);
  cleanupTasks.push(() => clearInterval(runTimer));

  let churnIndex = 0;
  const runChurn = async () => {
    if (stopping || churnRunning || performance.now() - soakStarted > (profile.soakSeconds - 20) * 1_000) return;
    churnRunning = true;
    const cohortCount = Math.max(1, Math.round(100 / profile.churnPercent));
    const selected = connectedContexts.filter((context) => context.ordinal % cohortCount === churnIndex % cohortCount);
    const cycle = {
      index: churnIndex,
      cohort: churnIndex % 10,
      selectedIdentitySha256: digest(stableJson(selected.map((context) => ({
        authenticatedUserId: context.fixture.authenticatedUserId,
        sourceIndex: context.fixture.sourceIndex,
      })))),
      startedAt: new Date().toISOString(),
      selected: selected.length,
      recovered: 0,
      within10: 0,
      within20: 0,
      p99Ms: null,
      failures: [],
    };
    churnIndex += 1;
    const tasks = selected.map(async (context) => {
      context.ready.clear();
      const generation = context.engineOpens + 1;
      const started = performance.now();
      context.manager.engine?.close();
      try {
        await waitForReady(context, generation, 20_000);
        const elapsed = performance.now() - started;
        cycle.recovered += 1;
        if (elapsed <= 10_000) cycle.within10 += 1;
        if (elapsed <= 20_000) cycle.within20 += 1;
        return elapsed;
      } catch (error) {
        cycle.failures.push({ fixtureIndex: context.fixture.sourceIndex, error: error.message });
        return null;
      }
    });
    const latencies = (await Promise.all(tasks)).filter(Number.isFinite);
    cycle.p99Ms = percentile(latencies, 0.99);
    cycle.finishedAt = new Date().toISOString();
    churnCycles.push(cycle);
    churnRunning = false;
  };
  const churnTimer = setInterval(() => {
    runChurn().catch((error) => {
      preflightFailures.push(`churn cycle failed: ${error.message}`);
      churnRunning = false;
    });
  }, profile.churnIntervalSeconds * 1_000);
  cleanupTasks.push(() => clearInterval(churnTimer));

  const soakDeadline = soakStarted + profile.soakSeconds * 1_000;
  while (!stopping && performance.now() < soakDeadline) {
    await sleep(Math.min(1_000, Math.max(1, soakDeadline - performance.now())));
  }
  stopping = true;
  clearInterval(sampleTimer);
  clearInterval(runTimer);
  clearInterval(churnTimer);
  while (churnRunning) await sleep(50);
  await sampleChain;
  await sleep(2);
  await appendSample('soak', (performance.now() - soakStarted) / 1_000);
  const soakFinishedAt = new Date().toISOString();
  await Promise.allSettled([...inFlightRuns]);
  const terminalDeadline = Date.now() + 15_000;
  while (metrics.runs.completed < metrics.runs.created && Date.now() < terminalDeadline) await sleep(50);
  const liveEvents = [...metrics.liveEvents.entries()]
    .map(([runId, signature]) => ({ runId, signature }))
    .sort((left, right) => left.runId - right.runId);
  const liveCompleteRunIds = liveEvents
    .filter((entry) => stableJson(entry.signature) === stableJson(EXPECTED_LIVE_EVENT_SIGNATURE))
    .map((entry) => entry.runId);
  const postDb = await reconcilePersistedRuns(target, metrics);
  const database = databaseReconciliation(
    databaseBaseline,
    databaseSnapshot(container),
    metrics.runs.created,
    postDb.totalEvents,
  );
  const workloadFinishedAt = new Date().toISOString();
  if (interruptedSignal) preflightFailures.push(`soak interrupted by ${interruptedSignal}`);
  const preTeardownProbe = parseLastJson(releaseRpc(
    container,
    'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()',
  ));
  for (const context of contexts) {
    context.closing = true;
    context.manager.disconnect();
  }

  const recoverySamples = [];
  let consecutivePassing = 0;
  const recoveryDeadline = Date.now() + profile.recoveryTimeoutSeconds * 1_000;
  while (!interruptedSignal && Date.now() < recoveryDeadline && consecutivePassing < profile.recoveryConsecutiveSamples) {
    await sleep(Math.max(10, profile.sampleIntervalSeconds) * 1_000);
    const sample = await appendSample('post-leave', (Date.now() - Date.parse(soakStartedAt)) / 1_000);
    recoverySamples.push(sample);
    const failures = returnToBaselineFailures(baselineReference, resourceVector(sample));
    consecutivePassing = failures.length === 0 ? consecutivePassing + 1 : 0;
  }

  let probeSummary = null;
  let postUninstall = null;
  let uninstallError = null;
  if (ownsProbe) {
    try {
      probeSummary = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.summary() |> Jason.encode!() |> IO.puts()'));
      parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()'));
      postUninstall = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
      if (postUninstall?.error !== 'capacity probe is not installed') {
        throw new Error('capacity probe remained installed after uninstall');
      }
      probeInstalled = false;
    } catch (error) {
      uninstallError = error.message;
    }
  }
  identity.final = currentIdentity(container);
  identity.runtimeFinal = runtimeIdentity(container);
  preflightFailures.push(...runtimeSampleFailures);
  if (uninstallError) preflightFailures.push(`capacity probe uninstall failed: ${uninstallError}`);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  const finishedAt = new Date().toISOString();
  const serverLogs = captureServerLogs(
    container,
    identity.initial.container.startedAt,
    finishedAt,
    serverLogFile,
  );
  preflightFailures.push(...serverLogFailures(serverLogs));
  const journalRaw = fs.readFileSync(journalFile, 'utf8');
  const journal = {
    path: journalFile,
    sha256: digest(journalRaw),
    bytes: Buffer.byteLength(journalRaw),
    samples: journalRaw.split(/\r?\n/u).filter(Boolean).length,
  };
  const evidence = {
    schemaVersion: 1,
    type: 'cascade-elixir-two-hour-soak-invariants',
    expectedImage,
    expectedRevision,
    target,
    sourceIp: sourceIp || null,
    profile,
    fixtures: fixtureArtifact,
    returnThresholds: RETURN_THRESHOLDS,
    identity,
    probe: {
      path: probePath,
      sha256: probeSha256,
      owned: ownsProbe,
      summary: probeSummary,
      uninstallError,
      postUninstall,
    },
    startedAt: baselineSamples[0]?.observedAt,
    soakStartedAt,
    soakFinishedAt,
    workloadFinishedAt,
    finishedAt,
    observed: { soakSeconds: (Date.parse(soakFinishedAt) - Date.parse(soakStartedAt)) / 1_000 },
    journal,
    serverLogs,
    baseline: { samples: baselineSamples.map(resourceVector), reference: baselineReference },
    workload: {
      rampStartedAt,
      rampCompletedAt,
      initialConnected: connectedContexts.length,
      initialConnectionFailures,
      churnCycles,
      runs: metrics.runs,
      runIds: {
        requested: sortedNumeric(metrics.requestedRunIds),
        delegated: sortedNumeric(metrics.delegatedRunIds),
        terminal: sortedNumeric(metrics.terminalRunIds),
        liveComplete: sortedNumeric(liveCompleteRunIds),
      },
      liveEvents,
      liveEventDigest: digest(stableJson(liveEvents)),
      runtimeCoverage: null,
    },
    recovery: {
      samples: recoverySamples.map(resourceVector),
      final: recoverySamples.length ? resourceVector(recoverySamples.at(-1)) : null,
      consecutivePassing,
    },
    postDb,
    database,
    teardown: teardownProbeEvidence(preTeardownProbe, probeSummary),
    preflightFailures,
  };
  const journalValidation = recomputeSoakJournal(evidence, parseSoakJournal(journalRaw));
  evidence.baseline = journalValidation.baseline;
  evidence.workload.runtimeCoverage = journalValidation.runtimeCoverage;
  evidence.recovery = journalValidation.recovery;
  evidence.journal.validation = {
    records: journalValidation.records,
    phases: journalValidation.phases,
    headroom: journalValidation.headroom,
    failures: journalValidation.failures,
  };
  evidence.evaluation = evaluateSoakEvidence(evidence);
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, journal, evaluation: evidence.evaluation }, null, 2)}\n`);
  if (!evidence.evaluation.ok) process.exitCode = 1;
  } finally {
    const cleanupFailures = [];
    for (const cleanup of cleanupTasks.reverse()) {
      try { await cleanup(); } catch (error) { cleanupFailures.push(error.message); }
    }
    if (cleanupFailures.length) throw new Error(`soak cleanup failed: ${cleanupFailures.join('; ')}`);
  }
}
