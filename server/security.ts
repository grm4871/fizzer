/**
 * @file security.ts — Network-mode security helpers
 *
 * Centralizes the hardening Cascade needs once its server is reachable beyond
 * localhost (a small shared instance for friends): a persisted JWT secret, a
 * CORS origin allowlist, and a tiny in-memory rate limiter for the auth routes.
 *
 * @module server/security
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const LEGACY_DEV_SECRET = 'cascade-dev-secret';

/** True when the instance is meant to be reachable off-localhost. */
export const NETWORK_MODE = /^(1|true|yes|on)$/i.test(process.env.CASCADE_NETWORK_MODE || '');

function persistedSecretPath(): string {
  const dir = path.join(os.homedir(), '.cascade');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'secret');
}

function persistedDeploySecretPath(): string {
  const dir = path.join(os.homedir(), '.cascade');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'deploy-secret');
}

/**
 * Resolve the JWT signing secret.
 *
 * Precedence: an explicit non-default `JWT_SECRET` env var wins. Otherwise a
 * random 256-bit secret is generated once and persisted to `~/.cascade/secret`
 * (0600) so tokens survive restarts. The legacy hardcoded dev secret is never
 * used, and in network mode an explicit `JWT_SECRET=cascade-dev-secret` is a
 * hard error rather than a silent foot-gun.
 */
export function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv !== LEGACY_DEV_SECRET) return fromEnv;

  if (fromEnv === LEGACY_DEV_SECRET && NETWORK_MODE) {
    throw new Error(
      'Refusing to start in network mode with the default JWT_SECRET. ' +
      'Set a strong JWT_SECRET env var, or unset it to auto-generate one.',
    );
  }

  const secretFile = persistedSecretPath();
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export function resolveDeploySecret(): string {
  const fromEnv = process.env.CASCADE_DEPLOY_TOKEN;
  if (fromEnv) return fromEnv;

  const secretFile = persistedDeploySecretPath();
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

/**
 * CORS `origin` option. In network mode only the configured allowlist
 * (`CASCADE_ALLOWED_ORIGINS`, comma-separated) plus origin-less requests
 * (native shells, curl, same-origin) are permitted. In local dev any origin is
 * reflected to preserve the existing convenience.
 */
export function corsOrigin() {
  if (!NETWORK_MODE) return true;
  const allowed = new Set(
    (process.env.CASCADE_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  // Capacitor serves bundled assets from a local app origin even when every
  // API request targets the production HTTPS host. These origins are native
  // WebViews, not remotely hosted Cascade frontends.
  allowed.add('https://localhost');
  allowed.add('capacitor://localhost');
  allowed.add('ionic://localhost');
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowed.has(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  };
}

/** How many expired buckets to drop per request, so the map cannot grow forever. */
const RATE_LIMIT_SWEEP = 64;

/**
 * Minimal fixed-window in-memory rate limiter. Sufficient to blunt credential
 * stuffing on the auth routes of a small single-process instance; not a
 * distributed limiter.
 *
 * `key` selects the bucket. It defaults to the client IP; routes that are
 * behind `requireAuth` should key on the account id instead, so one signed-in
 * user cannot spread an abuse loop across addresses.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const message = opts.message || 'Too many requests. Please try again shortly.';

  // Fixed windows expire but their entries do not, so a stream of distinct
  // keys would leak memory. Drop a bounded slice of dead buckets per call.
  const sweep = (now: number) => {
    let checked = 0;
    for (const [key, entry] of hits) {
      if (checked++ >= RATE_LIMIT_SWEEP) break;
      if (now > entry.resetAt) hits.delete(key);
    }
  };

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = opts.key?.(req) || req.ip || req.socket.remoteAddress || 'unknown';
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      sweep(now);
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
