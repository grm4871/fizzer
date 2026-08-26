#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { runMain } from './lib/soak-orchestrator.mjs';
import { SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, RETURN_THRESHOLDS, returnToBaselineFailures } from './lib/soak-inputs.mjs';
import { parseSoakJournal, recomputeSoakJournal, evaluateSoakEvidence } from './lib/soak-evaluator.mjs';
import { databaseReconciliation, teardownProbeEvidence } from './lib/soak-db.mjs';
import { persistedEventFailures } from './lib/soak-client.mjs';

export { runMain, SOAK_PROFILE, SOAK_RUNTIME_CONFIGURATION, RETURN_THRESHOLDS, returnToBaselineFailures, parseSoakJournal, recomputeSoakJournal, evaluateSoakEvidence, persistedEventFailures, databaseReconciliation, teardownProbeEvidence };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain().catch((error) => {
    console.error('[soak] fatal:', error?.stack || error);
    process.exitCode = 1;
  });
}
