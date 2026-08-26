import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as inputs from './certification-inputs.mjs';
import * as state from './certification-state.mjs';
import * as phases from './certification-phases.mjs';
import * as artifacts from './certification-artifacts.mjs';
const { invariant, parseArgs, validateOptions, validateAffinity, currentPhase, initializeOrLoad, validateRunRoots, validateScratch, cleanupScratch, terminateChildren, atomicState, finishManifest, executePhase, validateFinalPhaseIsolation, recordContainer, assertScratchEmpty } = { ...inputs, ...state, ...phases, ...artifacts };

/**
 * Certification CLI seam: parse, resume, execute the selected phase, and publish exit status.
 */
export async function main(argv = process.argv.slice(2)) {
  const options = validateOptions(parseArgs(argv));
  const affinity = validateAffinity();
  const phase = currentPhase();
  validateRunRoots(options, phase);
  const loaded = initializeOrLoad(options, phase, affinity);
  const context = { ...loaded, options, phase, affinity };
  context.scratch = validateScratch(context.state);
  const expectedIndex = context.state.completed.length;
  invariant(context.phaseSequence[expectedIndex] === phase.phase,
    `capacity phase ${phase.phase} is out of order; expected ${context.phaseSequence[expectedIndex] || 'none'}`);
  recordContainer(context.state, phase);
  try {
    await executePhase(context);
    assertScratchEmpty(context.scratch);
  } catch (error) {
    cleanupScratch();
    throw error;
  }
  context.state.completed.push(phase.phase);
  context.state.updatedAt = new Date().toISOString();
  recordContainer(context.state, phase);
  atomicState(context.stateFile, context.state);
  if (context.state.completed.length === context.phaseSequence.length) {
    cleanupScratch({ requireEmpty: true });
    finishManifest(context);
  }
}

let signalExit = false;
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (signalExit) return;
    signalExit = true;
    void terminateChildren(signal).finally(() => {
      try { cleanupScratch(); } catch (error) {
        console.error(`[capacity-certification-runner] scratch cleanup failed: ${error.message}`);
      }
      process.exit(exitCode);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    try { await terminateChildren(); } catch (cleanupError) {
      console.error(`[capacity-certification-runner] child cleanup failed: ${cleanupError.stack || cleanupError}`);
    }
    try { cleanupScratch(); } catch (cleanupError) {
      console.error(`[capacity-certification-runner] scratch cleanup failed: ${cleanupError.stack || cleanupError}`);
    }
    console.error(`[capacity-certification-runner] fatal: ${error.stack || error}`);
    process.exitCode = 1;
  });
}
