'use strict';

/**
 * Local, non-blocking activity captions for Orbit.
 *
 * The hosted renderer sends the user-editable prompt note through Electron IPC;
 * the main process is the only layer allowed to read local agent logs or call
 * the user's Ollama daemon. Captions are stale-while-revalidate so polling the
 * graph never waits for model generation.
 */
const crypto = require('node:crypto');

const DEFAULT_MODEL = process.env.ORBIT_CAPTION_MODEL || 'qwen3.5:9b-q4_K_M';
const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

function fingerprint(template, excerpt) {
  return crypto.createHash('sha1').update(template).update('\0').update(excerpt).digest('hex');
}

/** Enforce the prompt contract even when the model ignores it. */
function normalizeCaption(value, maxWords = 6) {
  const withoutThinking = String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const firstLine = withoutThinking.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const clean = firstLine
    .replace(/^(?:status|caption|activity)\s*[:\-]\s*/i, '')
    .replace(/["'`*_#.,!?;:()[\]{}<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.split(' ').filter(Boolean).slice(0, maxWords).join(' ');
}

function createCaptioner({
  fetchImpl = globalThis.fetch,
  model = DEFAULT_MODEL,
  ollamaUrl = DEFAULT_OLLAMA_URL,
  maxConcurrent = 1,
  retryAfterMs = 60_000,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  const queued = new Set();
  const running = new Set();
  const queue = [];
  let sequence = 0;
  let unavailableUntil = 0;

  const schedule = (id) => {
    if (queued.has(id) || running.has(id)) return;
    queued.add(id);
    queue.push(id);
    pump();
  };

  const run = async (id, job) => {
    running.add(id);
    try {
      const prompt = `/no_think ${job.template}\n\n--- AGENT LOG ---\n${job.excerpt}\n--- END LOG ---`;
      const response = await fetchImpl(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          think: false,
          options: { num_predict: 32, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        unavailableUntil = now() + retryAfterMs;
        return;
      }
      const data = await response.json();
      const caption = normalizeCaption(data?.response);
      // Publish completed work even if a fresher log arrived during inference;
      // otherwise a continuously-writing agent can starve the UI forever. A
      // later completion still wins by sequence number.
      if (caption && (!cache.get(id) || cache.get(id).sequence <= job.sequence)) {
        cache.set(id, { hash: job.hash, caption, sequence: job.sequence });
        unavailableUntil = 0;
      }
    } catch {
      // Ollama is optional. The scanner retains its deterministic fallback.
      unavailableUntil = now() + retryAfterMs;
    } finally {
      running.delete(id);
      if (pending.get(id)?.hash !== job.hash) schedule(id);
      pump();
    }
  };

  function pump() {
    while (running.size < maxConcurrent && queue.length > 0) {
      const id = queue.shift();
      queued.delete(id);
      const job = pending.get(id);
      if (job) void run(id, job);
    }
  }

  return {
    /** Return immediately, starting/coalescing a background refresh as needed. */
    getCaption(id, template, excerpt) {
      const cleanTemplate = String(template || '').trim();
      const cleanExcerpt = String(excerpt || '').trim();
      if (!cleanTemplate || !cleanExcerpt) return cache.get(id)?.caption || null;
      if (now() < unavailableUntil) return cache.get(id)?.caption || null;
      const hash = fingerprint(cleanTemplate, cleanExcerpt);
      const current = cache.get(id);
      if (current?.hash === hash) return current.caption;
      pending.set(id, { hash, template: cleanTemplate, excerpt: cleanExcerpt, sequence: ++sequence });
      schedule(id);
      return current?.caption || null;
    },
    getCached(id) {
      return cache.get(id)?.caption || null;
    },
  };
}

module.exports = { createCaptioner, normalizeCaption };
