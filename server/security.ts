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

const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' wss:",
  "frame-src https://www.youtube.com https://platform.twitter.com https://open.spotify.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join('; ');

const LANDING_CONTENT_SECURITY_POLICY = APP_CONTENT_SECURITY_POLICY.replace(
  "script-src 'self'",
  "script-src 'self' 'unsafe-inline'",
);

const PUBLIC_NOTE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors *",
  "img-src data: https:",
  "style-src 'unsafe-inline'",
].join('; ');

/**
 * Resolve how many reverse-proxy hops Express may trust when deriving req.ip.
 * Invalid values fail closed instead of silently trusting an arbitrary chain.
 */
export function resolveTrustProxyHops(raw = process.env.CASCADE_TRUST_PROXY_HOPS): number {
  if (raw == null || raw.trim() === '') return 0;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('CASCADE_TRUST_PROXY_HOPS must be an integer from 0 through 5');
  }
  const hops = Number(raw);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('CASCADE_TRUST_PROXY_HOPS must be an integer from 0 through 5');
  }
  return hops;
}

/** Keep new bcrypt credentials inside its 72-byte input boundary. */
export function passwordPolicyError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be at most 72 UTF-8 bytes';
  return null;
}

/** Browser hardening shared by API, static assets, and Socket.IO handshakes. */
export function securityHeaders(opts: { networkMode?: boolean } = {}) {
  const networkMode = opts.networkMode ?? NETWORK_MODE;
  return (req: Request, res: Response, next: NextFunction) => {
    const isPublicNote = req.path.startsWith('/p/');
    const isLandingPage = req.path === '/' || req.path === '/download';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader(
      'Content-Security-Policy',
      isPublicNote
        ? PUBLIC_NOTE_CONTENT_SECURITY_POLICY
        : isLandingPage
          ? LANDING_CONTENT_SECURITY_POLICY
          : APP_CONTENT_SECURITY_POLICY,
    );

    // Public note pages intentionally support the sandboxed oEmbed iframe.
    if (!isPublicNote) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    }

    if (networkMode && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

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
export function corsOrigin(networkMode = NETWORK_MODE) {
  if (!networkMode) return true;
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
    callback(new Error('Origin is not allowed by CORS'));
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
