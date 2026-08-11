import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
const ID_KEY = /^(?:id|user_?id|vault_?id|folder_?id|note_?id|channel_?id|message_?id|run_?id|event_?id|registration_?id|conversation_?id|parent_?id|reply_?id|source_?id|target_?id|asset_?id|mission_?id|task_?id)$/i;
const TIME_KEY = /(?:^|_)(?:created|updated|published|started|finished|completed|expires|deleted)_?at$|(?:At|Timestamp)$/i;
const TOKEN_KEY = /(?:^|_)(?:token|slug)$|(?:Token)$/i;
const SECRET_KEY = /password_hash|secret|digest/i;
const JSON_KEY = /(?:^|_)json$/i;

export const NORMALIZATION_RULES = Object.freeze([
  'Generated numeric and UUID identity fields become <id>.',
  'ISO/SQLite timestamps and timestamp fields become <timestamp>.',
  'JWTs, invite/public slugs, cookie values, password hashes, and secrets become opaque markers.',
  'Loopback origins become <origin> because each backend owns a different ephemeral port.',
]);

function normalizeString(value, key) {
  if (SECRET_KEY.test(key)) return '<secret>';
  if (TOKEN_KEY.test(key)) return '<token>';
  if (JSON_KEY.test(key)) {
    try { return normalizeValue(JSON.parse(value)); } catch { /* ordinary string */ }
  }
  return value
    .replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<origin>')
    .replace(/https?%3A%2F%2F127\.0\.0\.1%3A\d+/gi, '<origin>')
    .replace(/\/p\/[A-Za-z0-9_-]{16,}/g, '/p/<token>')
    .replace(/%2Fp%2F[A-Za-z0-9_-]{16,}/gi, '%2Fp%2F<token>')
    .replace(UUID, '<id>')
    .replace(ISO_TIME, '<timestamp>');
}

export function normalizeValue(value, key = '') {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (ID_KEY.test(key)) return '<id>';
    if (TIME_KEY.test(key)) return '<timestamp>';
    return value;
  }
  if (typeof value === 'string') {
    if (ID_KEY.test(key) && (/^\d+$/.test(value) || UUID.test(value))) {
      UUID.lastIndex = 0;
      return '<id>';
    }
    UUID.lastIndex = 0;
    if (TIME_KEY.test(key)) return '<timestamp>';
    return normalizeString(value, key);
  }
  if (Buffer.isBuffer(value)) return { $blob: value.toString('base64') };
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, key));
  return Object.fromEntries(Object.keys(value).sort().map((childKey) => [
    childKey,
    normalizeValue(value[childKey], childKey),
  ]));
}

export function normalizeHeaders(headers) {
  const input = headers instanceof Headers ? headers : new Headers(headers || {});
  const selected = {};
  for (const name of [
    'cache-control',
    'content-security-policy',
    'content-type',
    'cross-origin-opener-policy',
    'referrer-policy',
    'x-content-type-options',
    'x-frame-options',
  ]) selected[name] = input.get(name);
  const cookie = input.get('set-cookie');
  selected['set-cookie'] = cookie
    ? cookie.replace(/^([^=]+)=[^;]*/, '$1=<token>').replace(/Expires=[^;]+/i, 'Expires=<timestamp>')
    : null;
  return selected;
}

function pointer(pathParts) {
  return pathParts.length ? `$${pathParts.map((part) => `[${JSON.stringify(part)}]`).join('')}` : '$';
}

function brief(value, max = 600) {
  const rendered = JSON.stringify(value);
  if (rendered == null || rendered.length <= max) return rendered;
  return `${rendered.slice(0, max)}...<${rendered.length - max} more chars>`;
}

function stringMismatch(left, right, pathParts) {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const count = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < count; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return `${pointer(pathParts)} line ${index + 1}: ${brief(leftLines[index])} !== ${brief(rightLines[index])}`;
    }
  }
  return `${pointer(pathParts)}: string values differ`;
}

export function diffValues(left, right, pathParts = [], diffs = [], limit = 100) {
  if (diffs.length >= limit) return diffs;
  if (Object.is(left, right)) return diffs;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      diffs.push(`${pointer(pathParts)}: ${brief(left)} !== ${brief(right)}`);
      return diffs;
    }
    if (left.length !== right.length) diffs.push(`${pointer(pathParts)}.length: ${left.length} !== ${right.length}`);
    for (let index = 0; index < Math.max(left.length, right.length) && diffs.length < limit; index += 1) {
      diffValues(left[index], right[index], [...pathParts, index], diffs, limit);
    }
    return diffs;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!(key in left)) diffs.push(`${pointer([...pathParts, key])}: missing on node`);
      else if (!(key in right)) diffs.push(`${pointer([...pathParts, key])}: missing on elixir`);
      else diffValues(left[key], right[key], [...pathParts, key], diffs, limit);
      if (diffs.length >= limit) break;
    }
    return diffs;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    diffs.push(stringMismatch(left, right, pathParts));
    return diffs;
  }
  diffs.push(`${pointer(pathParts)}: ${brief(left)} !== ${brief(right)}`);
  return diffs;
}

export function compareBackendResults(nodeResult, elixirResult) {
  const node = normalizeValue(nodeResult);
  const elixir = normalizeValue(elixirResult);
  const preferred = ['transcript', 'socketEvents', 'database', 'vaultFiles'];
  const keys = [
    ...preferred.filter((key) => key in node || key in elixir),
    ...[...new Set([...Object.keys(node), ...Object.keys(elixir)])]
      .filter((key) => !preferred.includes(key))
      .sort(),
  ];
  const diffs = keys.flatMap((key) => diffValues(node[key], elixir[key], [key], [], 100));
  return { ok: diffs.length === 0, diffs, node, elixir };
}

const DIFFERENTIAL_CLUSTERS = Object.freeze([
  {
    id: 'http-cache-policy',
    title: 'HTTP cache header policy',
    matches: (diff) => diff.includes('["transcript"]') && diff.includes('["headers"]["cache-control"]'),
  },
  {
    id: 'vault-public-shape',
    title: 'Vault public metadata response shape',
    matches: (diff) => /\["transcript"\]\[(?:5|6)\]\["body"\]/.test(diff),
  },
  {
    id: 'chat-message-shape',
    title: 'Chat message response and vault-event shape',
    matches: (diff) => /\["transcript"\]\[(?:12|13)\]\["body"\]/.test(diff)
      || diff.includes('["socketEvents"]["vault"]'),
  },
  {
    id: 'public-page-template',
    title: 'Published-page HTML template',
    matches: (diff) => diff.includes('["transcript"][16]["body"]'),
  },
  {
    id: 'run-prompt-enrichment',
    title: 'Run prompt enrichment and persisted prompt',
    matches: (diff) => /\["transcript"\]\[(?:19|20)\]\["body"\]\["run"\]\["prompt"\]/.test(diff)
      || (diff.includes('["socketEvents"]["runners"]') && diff.includes('["prompt"]'))
      || (diff.includes('["database"]["tables"]["runs"]') && diff.includes('["prompt"]')),
  },
  {
    id: 'runner-delegate-shape',
    title: 'Runner delegation payload shape',
    matches: (diff) => diff.includes('["socketEvents"]["runners"]'),
  },
  {
    id: 'database-schema',
    title: 'SQLite schema definition and column order',
    matches: (diff) => diff.includes('["database"]["tables"]') && diff.includes('["columns"]'),
  },
  {
    id: 'agent-scratchpad-side-effects',
    title: 'Agent scratchpad database and vault-file side effects',
    matches: (diff) => /\["database"\]\["tables"\]\["(?:community_note_activity|folders|notes|notes_fts)"\]/.test(diff)
      || diff.includes('["vaultFiles"]'),
  },
]);

function transcriptStepForDiff(diff, transcript) {
  const match = diff.match(/\["transcript"\]\[(\d+)\]/);
  if (!match) return null;
  return transcript[Number(match[1])]?.label || `transcript[${match[1]}]`;
}

/**
 * Group already-normalized mismatches without suppressing any of them.
 * Unknown paths are deliberately retained in an explicit fail-closed cluster.
 */
export function clusterBackendDifferences(diffs, transcript = []) {
  const groups = new Map();
  for (const diff of diffs) {
    const definition = DIFFERENTIAL_CLUSTERS.find((candidate) => candidate.matches(diff)) || {
      id: 'unclassified-contract-gap',
      title: 'Unclassified contract gap',
    };
    const group = groups.get(definition.id) || {
      id: definition.id,
      title: definition.title,
      classification: 'contract-gap',
      count: 0,
      affectedHttpSteps: [],
      diffs: [],
    };
    group.count += 1;
    group.diffs.push(diff);
    const step = transcriptStepForDiff(diff, transcript);
    if (step && !group.affectedHttpSteps.includes(step)) group.affectedHttpSteps.push(step);
    groups.set(definition.id, group);
  }
  return [...groups.values()];
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function databaseInvariantSnapshot(filename) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma('quick_check', { simple: true });
    const foreignKeyViolations = db.pragma('foreign_key_check').map(normalizeValue);
    const names = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        AND name != 'cascade_elixir_schema_migrations'
      ORDER BY name
    `).all().map((row) => row.name)
      // Compare the logical FTS virtual tables below, not SQLite's private
      // segment/index encoding. Those shadow blobs are derived storage, not an
      // application invariant, and vary with insertion transaction boundaries.
      .filter((name) => !/_fts_(?:config|content|data|docsize|idx)$/i.test(name));
    const tables = {};
    for (const name of names) {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all()
        .map(({ name: columnName, type, notnull, dflt_value: defaultValue, pk }) => ({
          name: columnName, type, notnull, defaultValue, pk,
        }));
      const rows = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`).all()
        .map((row) => normalizeValue(row))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      tables[name] = { columns, count: rows.length, rows };
    }
    return { quickCheck, foreignKeyViolations, tables };
  } finally {
    db.close();
  }
}

function fileDigestOrText(filename) {
  const content = fs.readFileSync(filename);
  if (!content.includes(0)) return { text: normalizeString(content.toString('utf8'), 'file') };
  return { size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

export function vaultFileTreeSnapshot(root) {
  const entries = {};
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const child = path.posix.join(relative, entry.name).replace(UUID, '<id>');
      UUID.lastIndex = 0;
      if (entry.isDirectory()) {
        entries[child] = { type: 'directory' };
        visit(absolute, child);
      } else if (entry.isFile()) entries[child] = { type: 'file', ...fileDigestOrText(absolute) };
      else if (entry.isSymbolicLink()) entries[child] = { type: 'symlink', target: fs.readlinkSync(absolute) };
      else entries[child] = { type: 'other' };
    }
  }
  visit(root);
  return entries;
}
