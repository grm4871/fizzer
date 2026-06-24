/**
 * @file security.ts — Network-mode security helpers
 *
 * Centralizes the hardening Cascade needs once its server is reachable beyond
 * localhost (a small shared instance for friends): a persisted JWT secret, a
 * CORS origin allowlist, a feature gate for the arbitrary-shell widget command,
 * and a tiny in-memory rate limiter for the auth routes.
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

/**
 * Whether the arbitrary-shell widget command endpoint is enabled. Off by
 * default — it runs unsandboxed bash in the vault root and must be opted into.
 */
export const WIDGET_SHELL_ENABLED = /^(1|true|yes|on)$/i.test(process.env.CASCADE_ENABLE_WIDGET_SHELL || '');

function persistedSecretPath(): string {
  const dir = path.join(os.homedir(), '.cascade');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'secret');
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
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || allowed.has(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed by CORS`));
  };
}

/**
 * Minimal fixed-window in-memory rate limiter. Sufficient to blunt credential
 * stuffing on the auth routes of a small single-process instance; not a
 * distributed limiter.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    next();
  };
}
