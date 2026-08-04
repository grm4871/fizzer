/**
 * Fire-and-forget papercut jots into the live scratchpad journal.
 * Used by runners when tool failures surface so friction is captured without
 * relying on the model to remember to jot.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const countsByRun = new Map();
const MAX_PER_RUN = Math.max(1, Math.min(Number(process.env.CASCADE_PAPERCUT_MAX_PER_RUN || 12), 40));
const MIN_BODY = 24;
const recentBodies = new Map(); // runKey -> last body hash

function runKey() {
  return String(process.env.CASCADE_RUN_ID || process.env.CASCADE_HELPER_CONFIG || 'local');
}

function scratchpadBin() {
  const helperDir = process.env.CASCADE_HELPER_DIR || here;
  const candidate = path.join(helperDir, 'cascade-scratchpad');
  if (fs.existsSync(candidate)) return candidate;
  const local = path.join(here, 'cascade-scratchpad');
  return fs.existsSync(local) ? local : null;
}

/**
 * @param {string} body
 * @param {{ tool?: string }} [meta]
 */
export function autoPapercut(body, meta = {}) {
  try {
    const text = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (text.length < MIN_BODY) return;
    // Skip noise: pure cancels, empty permission prompts, known benign noise.
    if (/^canceled by user|^interrupt|^aborted/i.test(text)) return;
    if (/permission.?denied|user.?rejected/i.test(text) && text.length < 80) return;

    const key = runKey();
    const n = countsByRun.get(key) || 0;
    if (n >= MAX_PER_RUN) return;
    const hash = text.slice(0, 200);
    if (recentBodies.get(key) === hash) return;
    recentBodies.set(key, hash);
    countsByRun.set(key, n + 1);

    const bin = scratchpadBin();
    if (!bin) return;
    const label = meta.tool ? `${meta.tool}: ${text}` : text;
    const child = spawn(
      process.execPath,
      [bin, 'papercut', '--text', label],
      {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    child.unref();
  } catch {
    /* never break the agent on journal capture */
  }
}

export default autoPapercut;
