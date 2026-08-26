#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as parser from './lib/monitor-parsers.mjs';
import * as headroom from './lib/monitor-headroom.mjs';
import * as artifacts from './lib/monitor-artifacts.mjs';

const { parseArgs, numberOption, booleanOption, docker, dockerJson, releaseRpc, parseLastJson, readText, readNumber, parseKeyValues, cgroupPath, cpuLimit, captureServerLogs } = parser;
const { analyzeServerLogs, serverLogFailures, cpuSetCount, shapeFailures, histogramDelta, histogramPercentile } = parser;
const { headroomEvaluation, validateWorkloadResults } = headroom;
const { containerIdentityFailures, finalizationFailures, beamOpenFiles, containerBeamOpenFiles, parsePercent, cgroupSnapshot, readWorkloadMarker } = artifacts;
export { analyzeServerLogs, serverLogFailures, cpuSetCount, shapeFailures, histogramDelta, histogramPercentile, headroomEvaluation, validateWorkloadResults, containerIdentityFailures, finalizationFailures };

/**
 * Monitor main loop seam: periodic sampling, probe lifecycle, and final artifact emission.
 */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const container = String(args.container || 'cascade-elixir-capacity');
  const output = path.resolve(String(args.output || `/tmp/${container}-monitor.jsonl`));
  const serverLogOutput = path.resolve(String(args.serverLogOutput || `${output}.container.log`));
  const intervalSeconds = numberOption(args, 'intervalSeconds', 5, 0.5);
  const durationSeconds = numberOption(args, 'durationSeconds', 0, 0);
  const gateWindowSeconds = numberOption(args, 'gateWindowSeconds', 1_800, 1);
  const expectedCpus = numberOption(args, 'expectedCpus', 2, 1);
  const expectedMemoryGiB = numberOption(args, 'expectedMemoryGib', 3, 1);
  const expectedMemoryBytes = expectedMemoryGiB * 1024 ** 3;
  const expectedSessions = numberOption(args, 'expectedSessions', 10_000, 0);
  const expectedRunners = numberOption(args, 'expectedRunners', 10_000, 0);
  const expectedMemberships = numberOption(args, 'expectedMemberships', 50_000, 0);
  const expectedImage = String(args.expectedImage || '').trim();
  const workloadFinishedMarker = args.workloadFinishedMarker
    ? path.resolve(String(args.workloadFinishedMarker))
    : '';
  const minimumWorkloadSeconds = numberOption(args, 'minimumWorkloadSeconds', 0, 0);
  const minimumPostWorkloadSeconds = numberOption(args, 'minimumPostWorkloadSeconds', 30, 0);
  const expectedLoad = {
    target: String(args.expectedLoadTarget || '').replace(/\/$/u, ''),
    shardCount: numberOption(args, 'expectedShardCount', 4, 1),
    rampSeconds: numberOption(args, 'expectedRampSeconds', 300, 0),
    soakSeconds: numberOption(args, 'expectedSoakSeconds', 1_860, 1),
    pollingPercent: numberOption(args, 'expectedPollingPercent', 5, 0),
    reconnectPercent: numberOption(args, 'expectedReconnectPercent', 10, 0),
    reconnectAtSeconds: numberOption(args, 'expectedReconnectAtSeconds', 600, 0),
    sourceIps: String(args.expectedSourceIps || '').split(',').map((value) => value.trim()).filter(Boolean),
    gateWindowSeconds,
    rates: {
      chatRps: numberOption(args, 'expectedChatRps', 6.25, 0),
      readRps: numberOption(args, 'expectedReadRps', 12.5, 0),
      runRps: numberOption(args, 'expectedRunRps', 0.25, 0),
    },
  };
  const expectedRuntime = {
    httpAcceptors: numberOption(args, 'expectedHttpAcceptors', 4, 1),
    httpMaxConnections: numberOption(args, 'expectedHttpMaxConnections', 32_768, 1),
    httpBacklog: numberOption(args, 'expectedHttpBacklog', 65_535, 1),
    networkMode: booleanOption(args, 'expectedNetworkMode', true),
    trustProxyHops: numberOption(args, 'expectedTrustProxyHops', 1, 0),
    qmdWorkerEnabled: booleanOption(args, 'expectedQmdWorkerEnabled', true),
    realtimeHibernateAfterMs: numberOption(args, 'expectedRealtimeHibernateAfterMs', 5_000, 1_000),
    runnerOrphanReclaimMs: numberOption(args, 'expectedRunnerOrphanReclaimMs', 600_000, 120_000),
    sqlitePoolSize: numberOption(args, 'expectedSqlitePoolSize', 20, 1),
    sqliteBusyTimeoutMs: numberOption(args, 'expectedSqliteBusyTimeoutMs', 5_000, 1),
  };
  const expectedRealtime = {
    enabled: expectedSessions > 0 && Boolean(workloadFinishedMarker),
    authFull:
      expectedSessions + Math.round(expectedSessions * expectedLoad.reconnectPercent / 100),
    groupCount: Math.ceil(expectedSessions / 25),
    successfulChatWrites:
      (expectedLoad.rates.chatRps > 0
        ? Math.max(1, Math.floor(expectedLoad.rates.chatRps * expectedLoad.soakSeconds))
        : 0) * expectedLoad.shardCount,
  };
  const probePath = path.resolve(String(args.probe || path.join(path.dirname(fileURLToPath(import.meta.url)), 'capacity_probe.exs')));
  if (!fs.existsSync(probePath)) throw new Error(`capacity probe not found: ${probePath}`);
  const probeSha256 = createHash('sha256').update(fs.readFileSync(probePath)).digest('hex');
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const inspect = dockerJson(['inspect', container])[0];
  const expectedIdentity = {
    containerId: inspect.Id,
    imageId: expectedImage,
    startedAt: inspect.State.StartedAt,
  };
  const cgroup = cgroupPath(inspect.State.Pid);
  let image = null;
  let imageInspectError = null;
  try {
    image = dockerJson(['image', 'inspect', inspect.Image])[0];
  } catch (error) {
    imageInspectError = error.message;
  }
  const preflightFailures = shapeFailures(inspect.HostConfig, expectedCpus, expectedMemoryBytes);
  if (workloadFinishedMarker && fs.existsSync(workloadFinishedMarker)) {
    preflightFailures.push(`workload-finished marker already exists: ${workloadFinishedMarker}`);
  }
  if (fs.existsSync(serverLogOutput)) {
    preflightFailures.push(`server-log output already exists: ${serverLogOutput}`);
  }
  if (workloadFinishedMarker && !expectedLoad.target) {
    preflightFailures.push('--expected-load-target is required with a workload-finished marker');
  }
  if (workloadFinishedMarker && expectedLoad.sourceIps.length !== expectedLoad.shardCount) {
    preflightFailures.push(
      `expected ${expectedLoad.shardCount} source IPs, received ${expectedLoad.sourceIps.length}`,
    );
  }
  if (!image) preflightFailures.push(`running image ${inspect.Image} is not locally inspectable`);
  if (!expectedImage) {
    preflightFailures.push('--expected-image is required (use the immutable sha256 image ID)');
  } else if (!expectedImage.startsWith('sha256:')) {
    preflightFailures.push('--expected-image must be an immutable sha256 image ID');
  } else if (inspect.Image !== expectedImage) {
    preflightFailures.push(`running image ${inspect.Image} does not match ${expectedImage}`);
  }
  const startedAt = new Date().toISOString();
  let stopping = false;
  let priorCpu = null;
  let priorAt = null;
  let sampleCount = 0;
  const samples = [];

  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  const probeLibrary = path.join(path.dirname(probePath), 'lib');
  const probeModules = ['capacity_probe_metrics.exs', 'capacity_probe_server.exs'];
  docker('cp', probePath, `${container}:/tmp/cascade-capacity-probe.exs`);
  if (probeModules.every((name) => fs.existsSync(path.join(probeLibrary, name)))) {
    docker('exec', container, 'mkdir', '-p', '/tmp/lib');
    for (const module of probeModules) {
      docker('cp', path.join(probeLibrary, module), `${container}:/tmp/lib/${module}`);
    }
  }
  const install = releaseRpc(
    container,
    'Code.eval_file("/tmp/cascade-capacity-probe.exs"); {:ok, snapshot} = CascadeCapacityProbe.install(); Jason.encode!(snapshot) |> IO.puts()',
  );

  fs.writeFileSync(output, `${JSON.stringify({
    type: 'start',
    observedAt: startedAt,
    container,
    containerId: inspect.Id,
    imageId: inspect.Image,
    imageRepoDigests: image?.RepoDigests || [],
    imageCreated: image?.Created || null,
    imageInspectError,
    probeSha256,
    hostConfig: {
      nanoCpus: inspect.HostConfig.NanoCpus,
      cpusetCpus: inspect.HostConfig.CpusetCpus,
      memory: inspect.HostConfig.Memory,
      memorySwap: inspect.HostConfig.MemorySwap,
      pidsLimit: inspect.HostConfig.PidsLimit,
      ulimits: inspect.HostConfig.Ulimits,
    },
    cgroup,
    expectedShape: {
      cpus: expectedCpus,
      memoryBytes: expectedMemoryBytes,
      sessions: expectedSessions,
      runners: expectedRunners,
      memberships: expectedMemberships,
      imageId: expectedImage,
      runtime: expectedRuntime,
      realtime: expectedRealtime,
    },
    monitorConfig: {
      intervalSeconds,
      durationSeconds,
      gateWindowSeconds,
      workloadFinishedMarker: workloadFinishedMarker || null,
      minimumWorkloadSeconds,
      minimumPostWorkloadSeconds,
      expectedLoad,
    },
    serverLogEvidence: {
      baselineCursor: inspect.State.StartedAt,
      monitorStartedAt: startedAt,
      output: serverLogOutput,
      policy: 'zero fatal/error lines from container start through monitor finish',
    },
    preflightFailures,
    probe: parseLastJson(install),
  })}\n`, { mode: 0o600 });

  const deadline = durationSeconds > 0 ? Date.now() + durationSeconds * 1_000 : Infinity;
  while (!stopping && Date.now() < deadline) {
    const observedAt = new Date().toISOString();
    const sampleStarted = performance.now();
    const currentInspect = dockerJson(['inspect', container])[0];
    const cgroupData = cgroupSnapshot(cgroup);
    const usageUsec = cgroupData?.cpu?.usage_usec ?? null;
    let normalizedCpuPct = null;

    if (usageUsec != null && priorCpu != null && priorAt != null) {
      const elapsedUsec = (Date.now() - priorAt) * 1_000;
      const allocatedCpus = cpuLimit(currentInspect.HostConfig) || 1;
      normalizedCpuPct = elapsedUsec > 0 ? (usageUsec - priorCpu) / elapsedUsec / allocatedCpus * 100 : null;
    }
    priorCpu = usageUsec;
    priorAt = Date.now();

    let beam;
    let stats;
    const errors = [];
    errors.push(...containerIdentityFailures(
      {
        containerId: currentInspect.Id,
        imageId: currentInspect.Image,
        startedAt: currentInspect.State.StartedAt,
      },
      expectedIdentity,
    ));
    errors.push(...shapeFailures(currentInspect.HostConfig, expectedCpus, expectedMemoryBytes));
    try {
      beam = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.snapshot() |> Jason.encode!() |> IO.puts()'));
    } catch (error) {
      errors.push(`beam: ${error.message}`);
    }
    try {
      stats = JSON.parse(docker('stats', '--no-stream', '--format', '{{json .}}', container));
    } catch (error) {
      errors.push(`docker stats: ${error.message}`);
    }

    const allocatedCpus = cpuLimit(currentInspect.HostConfig) || 1;
    if (normalizedCpuPct == null) {
      const dockerCpuPct = parsePercent(stats?.CPUPerc);
      normalizedCpuPct = dockerCpuPct == null ? null : dockerCpuPct / allocatedCpus;
    }
    const dockerMemoryPct = parsePercent(stats?.MemPerc);
    const memoryCurrent = cgroupData?.memoryCurrent ?? (dockerMemoryPct == null
      ? null
      : dockerMemoryPct / 100 * currentInspect.HostConfig.Memory);
    const openFiles = beamOpenFiles(cgroup) || containerBeamOpenFiles(container);

    const sample = {
      type: 'sample',
      observedAt,
      elapsedSeconds: (Date.parse(observedAt) - Date.parse(startedAt)) / 1_000,
      sampleDurationMs: Math.round((performance.now() - sampleStarted) * 10) / 10,
      normalizedCpuPct,
      memoryCurrent,
      dockerStats: stats,
      cgroup: cgroupData,
      beamOpenFiles: openFiles,
      containerState: {
        containerId: currentInspect.Id,
        imageId: currentInspect.Image,
        startedAt: currentInspect.State.StartedAt,
        nanoCpus: currentInspect.HostConfig.NanoCpus,
        cpusetCpus: currentInspect.HostConfig.CpusetCpus,
        memory: currentInspect.HostConfig.Memory,
        memorySwap: currentInspect.HostConfig.MemorySwap,
        pidsLimit: currentInspect.HostConfig.PidsLimit,
        ulimits: currentInspect.HostConfig.Ulimits,
        running: currentInspect.State.Running,
        restartCount: currentInspect.RestartCount,
        oomKilled: currentInspect.State.OOMKilled,
        exitCode: currentInspect.State.ExitCode,
      },
      beam,
      errors,
    };
    samples.push(sample);
    fs.appendFileSync(output, `${JSON.stringify(sample)}\n`);

    sampleCount += 1;
    if (sampleCount % Math.max(1, Math.round(60 / intervalSeconds)) === 0) {
      process.stdout.write(`[capacity-monitor] samples=${sampleCount} cpu=${normalizedCpuPct?.toFixed(1) ?? 'n/a'}% memory=${cgroupData?.memoryCurrent ?? 'n/a'} sessions=${beam?.beam?.realtimeSessions ?? 'n/a'}\n`);
    }

    const remaining = intervalSeconds * 1_000 - (performance.now() - sampleStarted);
    if (remaining > 0) await sleep(remaining);
  }

  let probeSummary;
  let uninstallError = null;
  try {
    probeSummary = parseLastJson(releaseRpc(container, 'CascadeCapacityProbe.summary() |> Jason.encode!() |> IO.puts()'));
    releaseRpc(container, 'CascadeCapacityProbe.uninstall() |> Jason.encode!() |> IO.puts()');
  } catch (error) {
    uninstallError = error.message;
  }
  const finalInspect = dockerJson(['inspect', container])[0];
  const serverLogs = captureServerLogs(
    container,
    inspect.State.StartedAt,
    new Date().toISOString(),
    serverLogOutput,
  );
  const finalContainerState = {
    containerId: finalInspect.Id,
    imageId: finalInspect.Image,
    startedAt: finalInspect.State.StartedAt,
    nanoCpus: finalInspect.HostConfig.NanoCpus,
    cpusetCpus: finalInspect.HostConfig.CpusetCpus,
    memory: finalInspect.HostConfig.Memory,
    memorySwap: finalInspect.HostConfig.MemorySwap,
    pidsLimit: finalInspect.HostConfig.PidsLimit,
    ulimits: finalInspect.HostConfig.Ulimits,
    running: finalInspect.State.Running,
    restartCount: finalInspect.RestartCount,
    oomKilled: finalInspect.State.OOMKilled,
    exitCode: finalInspect.State.ExitCode,
  };
  preflightFailures.push(...finalizationFailures(
    probeSummary,
    uninstallError,
    finalContainerState,
    expectedIdentity,
  ));
  preflightFailures.push(...shapeFailures(finalInspect.HostConfig, expectedCpus, expectedMemoryBytes));
  preflightFailures.push(...serverLogFailures(serverLogs));
  let workload = null;
  if (workloadFinishedMarker) {
    try {
      workload = readWorkloadMarker(
        workloadFinishedMarker,
        startedAt,
        expectedSessions,
        minimumWorkloadSeconds,
        expectedLoad,
      );
      const postWorkloadSeconds = (samples.at(-1)?.elapsedSeconds || 0) - workload.elapsedSeconds;
      workload.postWorkloadSeconds = postWorkloadSeconds;
      workload.postWorkloadSamples = samples.filter((sample) =>
        sample.elapsedSeconds > workload.elapsedSeconds).length;
      if (postWorkloadSeconds < minimumPostWorkloadSeconds) {
        preflightFailures.push(
          `post-workload monitoring covers ${postWorkloadSeconds.toFixed(1)}s, expected >=${minimumPostWorkloadSeconds}s`,
        );
      }
    } catch (error) {
      preflightFailures.push(`invalid workload-finished marker: ${error.message}`);
    }
  }

  const evaluation = headroomEvaluation(
    samples,
    gateWindowSeconds,
    expectedMemoryBytes,
    expectedCpus,
    expectedSessions,
    expectedRunners,
    expectedMemberships,
    preflightFailures,
    expectedRuntime,
    durationSeconds,
    intervalSeconds,
    workload?.gateEndSeconds ?? null,
    {
      ...expectedRealtime,
      initialOwnedChatChannels: workload?.presencePlan?.initialOwnedChatChannels,
      forcedReconnectOwnedChatChannels:
        workload?.presencePlan?.forcedReconnectOwnedChatChannels,
    },
  );
  fs.appendFileSync(output, `${JSON.stringify({
    type: 'finish',
    observedAt: new Date().toISOString(),
    samples: sampleCount,
    probeSummary,
    uninstallError,
    workload,
    serverLogs,
    evaluation,
    containerState: finalContainerState,
  })}\n`);
  process.stdout.write(`[capacity-monitor] wrote ${sampleCount} samples and final probe summary to ${output}\n`);
  if (!evaluation.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[monitor] fatal:', error?.stack || error);
    process.exitCode = 1;
  });
}
