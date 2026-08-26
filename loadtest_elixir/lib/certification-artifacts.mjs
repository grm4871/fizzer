import fs from 'node:fs';
import path from 'node:path';
import { profiles, finalPhases, diagnosticPhases, invariant, sha256, stableJson, tools, root, stateName, journalName, manifestName, scratchName, certifiedImage, fileEvidence } from './certification-inputs.mjs';
import { readJson, atomicState, output, appendJournal, runCommand, cleanupScratch, assertScratchEmpty, preflightPath, freezePath, assertArtifactAbsent, writeExclusiveJson } from './certification-state.mjs';
import { runPreflight, writeRuntimeProof, runShardedProfile, runReconciliationAndFreeze, runFreeze, runFaults, runSoak } from './certification-phases.mjs';

/**
 * Certification artifact seam: final certification, manifest, and phase state transitions.
 * Evidence invariant: only the declared final phase order can produce a certification manifest.
 */

export function artifactEvidence(directory) {
  return fs.readdirSync(directory).sort().flatMap((name) => {
    if ([stateName, journalName, manifestName, scratchName].includes(name) || name.endsWith('.tmp')) return [];
    const filename = path.join(directory, name);
    const metadata = fs.lstatSync(filename);
    invariant(metadata.isFile() && !metadata.isSymbolicLink(), `result artifact is not regular: ${name}`);
    return [[name, fileEvidence(filename)]];
  });
}

export function validateJournal(filename) {
  const records = fs.readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line));
  let priorDigest = '0'.repeat(64);
  for (const record of records) {
    invariant(record.priorDigest === priorDigest, 'command journal hash chain is broken');
    const { digest, ...body } = record;
    invariant(digest === sha256(stableJson(body)), 'command journal record digest is invalid');
    priorDigest = digest;
  }
  return { records, sha256: sha256(fs.readFileSync(filename)), tailDigest: priorDigest };
}

export async function runCertification(context) {
  const certificate = output(context.options, 'certification.json');
  assertArtifactAbsent(certificate);
  const shards = Array.from({ length: 4 }, (_unused, index) => output(context.options, `shard-${index}.json`));
  await runCommand(context, process.execPath, [
    certifiedImage, 'certify',
    '--image', context.options.image,
    '--source-database', context.options.sourceDatabase,
    '--source-corpus-root', context.options.sourceCorpusRoot,
    '--fixture', context.options.fixture,
    '--load-driver', tools.load,
    '--reconciliation-driver', tools.reconcile,
    '--fixture-preflight', preflightPath(context.options, 'main10k'),
    '--fault-preflight', preflightPath(context.options, 'faults'),
    '--soak-preflight', preflightPath(context.options, 'soak5k'),
    '--runtime-proof', output(context.options, 'runtime-proof.json'),
    '--monitor', output(context.options, 'monitor.jsonl'),
    ...shards.flatMap((filename) => ['--load-result', filename]),
    '--reconciliation', output(context.options, 'reconciliation.json'),
    '--main-freeze', freezePath(context.options, 'main10k'),
    '--fault-result', output(context.options, 'runner-restart.json'),
    '--fault-result', output(context.options, 'sqlite-lock.json'),
    '--fault-freeze', freezePath(context.options, 'faults'),
    '--soak-result', output(context.options, 'soak-invariants.json'),
    '--soak-freeze', freezePath(context.options, 'soak5k'),
    '--scratch-directory', context.scratch.path,
    '--output', certificate,
  ], 'final-image-certification');
  invariant(fs.existsSync(certificate) && fs.existsSync(`${certificate}.sha256`),
    'final certifier did not create the manifest and checksum');
}

export function validateFinalPhaseIsolation(state) {
  const candidates = ['main10k', 'faults', 'soak5k'].map((phase) => state.containers[phase]);
  invariant(candidates.every((candidate) => candidate?.identity?.containerId
    && candidate.identity.dataDir && candidate.databaseDeviceInode
    && candidate.databaseSha256 && candidate.databaseFrozenAt),
  'final capacity candidates are missing stopped/frozen identities');
  for (const [selector, label] of [
    [(candidate) => candidate.identity.containerId, 'container IDs'],
    [(candidate) => candidate.identity.dataDir, 'data roots'],
    [(candidate) => candidate.databaseDeviceInode, 'database inodes'],
  ]) {
    invariant(new Set(candidates.map(selector)).size === candidates.length,
      `final capacity ${label} are not pairwise distinct`);
  }
  const mainFrozenAt = Date.parse(candidates[0].databaseFrozenAt);
  invariant(Number.isFinite(mainFrozenAt)
    && candidates.slice(1).every((candidate) => Date.parse(candidate.startedAt) >= mainFrozenAt),
  'fault or soak phase started before main10k reconciliation/freeze completed');
}

export async function executePhase(context) {
  switch (context.phase.phase) {
    case 'preflight-diagnostic':
      await runPreflight(context, 'diagnostic', 'diagnostic1k');
      break;
    case 'run-diagnostic':
      await runShardedProfile(context, profiles.diagnostic1k);
      break;
    case 'freeze-diagnostic':
      await runFreeze(context, 'diagnostic');
      break;
    case 'preflight-main10k':
      await runPreflight(context, 'main10k', 'final10k');
      break;
    case 'run-main10k':
      await writeRuntimeProof(context);
      await runShardedProfile(context, profiles.final10k);
      break;
    case 'reconcile-main10k':
      await runReconciliationAndFreeze(context);
      break;
    case 'preflight-faults':
      await runPreflight(context, 'faults', 'final10k');
      break;
    case 'run-faults':
      await runFaults(context);
      break;
    case 'freeze-faults':
      await runFreeze(context, 'faults');
      break;
    case 'preflight-soak5k':
      await runPreflight(context, 'soak5k', 'final10k');
      break;
    case 'run-soak5k':
      await runSoak(context);
      break;
    case 'freeze-soak5k':
      await runFreeze(context, 'soak5k');
      break;
    case 'certify':
      validateFinalPhaseIsolation(context.state);
      await runCertification(context);
      break;
    default:
      throw new Error(`unsupported capacity phase ${context.phase.phase}`);
  }
}

export function recordContainer(state, phase) {
  const logical = phase.phase === 'certify'
    ? 'main10k'
    : phase.phase.replace(/^(?:preflight-|run-|reconcile-|freeze-)/u, '');
  const prior = state.containers[logical];
  const identity = {
    containerId: phase.containerId,
    containerName: phase.containerName,
    target: phase.target,
    dataDir: phase.dataDir,
  };
  if (prior) invariant(stableJson(prior.identity) === stableJson(identity),
    `${logical} container/data identity changed between lifecycle phases`);
  const finalizing = phase.phase === 'reconcile-main10k' || phase.phase.startsWith('freeze-');
  state.containers[logical] = {
    identity,
    createdAt: phase.createdAt || prior?.createdAt || null,
    startedAt: phase.startedAt || prior?.startedAt || null,
    stoppedAt: phase.stoppedAt || prior?.stoppedAt || null,
    databaseSha256: finalizing
      ? phase.databaseSha256 : prior?.databaseSha256 || phase.databaseSha256 || null,
    databaseDeviceInode: finalizing
      ? phase.databaseDeviceInode : prior?.databaseDeviceInode || phase.databaseDeviceInode || null,
    databaseFrozenAt: finalizing
      ? phase.databaseFrozenAt : prior?.databaseFrozenAt || phase.databaseFrozenAt || null,
  };
}

export function finishManifest(context) {
  const filename = output(context.options, manifestName);
  assertArtifactAbsent(filename);
  const journal = validateJournal(context.journalFile);
  const artifacts = Object.fromEntries(artifactEvidence(context.options.resultsDir));
  const manifest = {
    schemaVersion: 1,
    type: 'cascade-capacity-command-manifest',
    profile: context.options.profile,
    imageId: context.options.imageId,
    revision: context.options.revision,
    target: context.phase.target,
    completedAt: new Date().toISOString(),
    affinity: context.affinity,
    frozenInputs: context.state.inputs,
    containers: context.state.containers,
    commands: {
      journal: context.journalFile,
      sha256: journal.sha256,
      tailDigest: journal.tailDigest,
      records: journal.records,
    },
    artifacts,
  };
  writeExclusiveJson(filename, manifest);
}

