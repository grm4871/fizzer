#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { main } from './lib/certification-cli.mjs';
export { main };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[certification] fatal:', error?.stack || error);
    process.exitCode = 1;
  });
}
