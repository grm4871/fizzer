import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Load input seam: CLI decoding, fixture validation, and deterministic provenance.
 * Failure mode: malformed JWTs, duplicate identities, or split peer groups fail before sockets open.
 */
const DEFAULT_BOUNDS_MS = [5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000];
const loadDriverPath = fileURLToPath(import.meta.url);
const loadDriverBytes = fs.readFileSync(loadDriverPath);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

export function loadConfiguration(result) {
  return {
    target: result.target,
    sourceIp: result.sourceIp || null,
    shard: result.shard,
    requestedUsers: result.requestedUsers,
    rampSeconds: result.rampSeconds,
    soakSeconds: result.soakSeconds,
    pollingPercent: result.pollingPercent,
    reconnectPercent: result.reconnectPercent,
    reconnectAtSeconds: result.reconnectAtSeconds,
    selectionPlan: result.selectionPlan,
    presencePlan: result.presencePlan,
    rates: result.rates,
    thresholds: result.thresholds,
  };
}

export class Histogram {
  constructor(bounds = DEFAULT_BOUNDS_MS) {
    this.bounds = [...bounds];
    this.buckets = new Array(this.bounds.length + 1).fill(0);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }

  observe(value) {
    const n = Math.max(0, Number(value) || 0);
    const index = this.bounds.findIndex((bound) => n <= bound);
    this.buckets[index < 0 ? this.bounds.length : index] += 1;
    this.count += 1;
    this.sum += n;
    this.max = Math.max(this.max, n);
  }

  percentile(percent) {
    if (!this.count) return 0;
    const wanted = Math.ceil(this.count * percent);
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i += 1) {
      seen += this.buckets[i];
      if (seen >= wanted) return i < this.bounds.length ? this.bounds[i] : this.max;
    }
    return this.max;
  }

  summary() {
    return {
      count: this.count,
      meanMs: this.count ? Math.round((this.sum / this.count) * 10) / 10 : 0,
      p50Ms: this.percentile(0.5),
      p95Ms: this.percentile(0.95),
      p99Ms: this.percentile(0.99),
      maxMs: Math.round(this.max * 10) / 10,
    };
  }
}

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (inline !== undefined) values[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values[key] = argv[++i];
    else values[key] = true;
  }
  return values;
}

export function readFixtures(file, { users = Infinity, shardIndex = 0, shardCount = 1 } = {}) {
  return parseFixtures(fs.readFileSync(file, 'utf8'), { users, shardIndex, shardCount });
}

export function parseFixtures(text, { users = Infinity, shardIndex = 0, shardCount = 1 } = {}) {
  const parsed = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, lineIndex) => {
      let fixture;
      try { fixture = JSON.parse(line); } catch { throw new Error(`Invalid JSON on fixture line ${lineIndex + 1}`); }
      for (const key of ['token', 'vaultId', 'channelId']) {
        if (typeof fixture[key] !== 'string' || !fixture[key]) {
          throw new Error(`Fixture line ${lineIndex + 1} is missing ${key}`);
        }
      }
      if (!Number.isInteger(fixture.ownedChatChannels) || fixture.ownedChatChannels < 0) {
        throw new Error(`Fixture line ${lineIndex + 1} has no exact ownedChatChannels count`);
      }
      let claims;
      try {
        const parts = fixture.token.split('.');
        if (parts.length !== 3) throw new Error('not a JWT');
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        throw new Error(`Fixture line ${lineIndex + 1} token has no decodable JWT identity`);
      }
      if (!Number.isInteger(claims?.id) || typeof claims?.username !== 'string' || !claims.username) {
        throw new Error(`Fixture line ${lineIndex + 1} token has no valid user identity`);
      }
      return { ...fixture, authenticatedUserId: claims.id, sourceIndex: lineIndex };
    });
  const tokenLines = new Map();
  const userLines = new Map();
  for (const fixture of parsed) {
    const prior = tokenLines.get(fixture.token);
    if (prior != null) throw new Error(`Fixture lines ${prior + 1} and ${fixture.sourceIndex + 1} reuse one token`);
    tokenLines.set(fixture.token, fixture.sourceIndex);
    const priorUser = userLines.get(fixture.authenticatedUserId);
    if (priorUser != null) {
      throw new Error(`Fixture lines ${priorUser + 1} and ${fixture.sourceIndex + 1} reuse one authenticated user`);
    }
    userLines.set(fixture.authenticatedUserId, fixture.sourceIndex);
  }
  const groups = new Map();
  for (const fixture of parsed) {
    const groupKey = `${fixture.vaultId}\u0000${fixture.channelId}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(fixture);
  }
  for (const [groupKey, group] of groups) {
    const ownedChatChannels = group.reduce((sum, fixture) => sum + fixture.ownedChatChannels, 0);
    if (ownedChatChannels !== 1) {
      throw new Error(`Fixture vault/channel group ${groupKey} owns ${ownedChatChannels} chat channels, expected exactly 1`);
    }
  }
  const selected = [];
  let groupIndex = 0;
  for (const group of groups.values()) {
    const belongsToShard = groupIndex % shardCount === shardIndex;
    groupIndex += 1;
    if (!belongsToShard || selected.length >= users) continue;
    if (selected.length + group.length > users) {
      throw new Error(`--users=${users} would split a ${group.length}-user vault/channel peer group`);
    }
    selected.push(...group);
  }
  return selected;
}

export function numberOption(args, key, fallback, { min = 0 } = {}) {
  const value = args[key] == null ? fallback : Number(args[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${key} must be >= ${min}`);
  return value;
}

export function boolOption(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

