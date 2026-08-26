#!/usr/bin/env node

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { run } from './lib/load-runner.mjs';
import { loadConfiguration, Histogram, parseArgs, readFixtures, parseFixtures } from './lib/load-inputs.mjs';
import { WorkloadTracker, fixtureGroupKey, validChatPostResponse, validChatReadResponse, unexpectedLoadBroadcast, reclassifyPendingPeerReceiptsForReconnect, selectedCountForShard, selectedByPercent, reconnectSelectionForFixtures, presencePlanForFixtures } from './lib/load-tracker.mjs';
import { evaluate } from './lib/load-evaluator.mjs';

const loadDriverPath = fileURLToPath(import.meta.url);
const loadDriverBytes = fs.readFileSync(loadDriverPath);

export { loadConfiguration, Histogram, parseArgs, readFixtures, parseFixtures, WorkloadTracker, fixtureGroupKey, validChatPostResponse, validChatReadResponse, unexpectedLoadBroadcast, reclassifyPendingPeerReceiptsForReconnect, selectedCountForShard, selectedByPercent, reconnectSelectionForFixtures, presencePlanForFixtures, evaluate, run };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(loadDriverBytes).catch((error) => {
    console.error('[load] fatal:', error?.stack || error);
    process.exitCode = 1;
  });
}
