import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { corsOrigin, passwordPolicyError, rateLimit, resolveTrustProxyHops, securityHeaders } from './security.js';

type Call = { status: number | null; body: unknown; headers: Record<string, string>; passed: boolean };

/** Drives the middleware once and records whatever it did to the response. */
function hit(
  middleware: ReturnType<typeof rateLimit>,
  req: { ip?: string; user?: { id: number } },
): Call {
  const call: Call = { status: null, body: null, headers: {}, passed: false };
  const res = {
    setHeader: (name: string, value: string) => { call.headers[name.toLowerCase()] = value; },
    status: (code: number) => { call.status = code; return res; },
    json: (body: unknown) => { call.body = body; return res; },
  } as unknown as Response;
  const next: NextFunction = () => { call.passed = true; };
  middleware({ socket: {}, ...req } as unknown as Request, res, next);
  return call;
}

test('a per-user key limits one account without touching another', () => {
  const middleware = rateLimit({
    windowMs: 60_000,
    max: 2,
    key: (req) => String((req as Request & { user?: { id: number } }).user?.id ?? req.ip),
    message: 'Slow down',
  });
  const alice = { ip: '10.0.0.1', user: { id: 1 } };

  assert.equal(hit(middleware, alice).passed, true);
  assert.equal(hit(middleware, alice).passed, true);

  const blocked = hit(middleware, alice);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: 'Slow down' });
  assert.equal(blocked.headers['retry-after'], '60');

  // Changing address does not refill an account's bucket...
  assert.equal(hit(middleware, { ip: '10.0.0.99', user: { id: 1 } }).passed, false);
  // ...and a different account is unaffected, even from the same address.
  assert.equal(hit(middleware, { ip: '10.0.0.1', user: { id: 2 } }).passed, true);
});

test('the window reopens, and a flood of one-shot keys keeps working', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.after(() => mock.timers.reset());

  const middleware = rateLimit({ windowMs: 1_000, max: 1, key: (req) => String(req.ip) });
  assert.equal(hit(middleware, { ip: '10.0.0.1' }).passed, true);
  assert.equal(hit(middleware, { ip: '10.0.0.1' }).passed, false);

  t.mock.timers.tick(1_001);
  assert.equal(hit(middleware, { ip: '10.0.0.1' }).passed, true);

  // A long stream of one-shot keys must not accumulate: every bucket from the
  // expired window is dropped as later requests arrive.
  for (let i = 0; i < 200; i += 1) hit(middleware, { ip: `10.1.0.${i}` });
  t.mock.timers.tick(1_001);
  for (let i = 0; i < 200; i += 1) assert.equal(hit(middleware, { ip: `10.1.0.${i}` }).passed, true);
});

test('without a key function the limiter still falls back to the client address', () => {
  const middleware = rateLimit({ windowMs: 60_000, max: 1 });
  assert.equal(hit(middleware, { ip: '10.0.0.1' }).passed, true);
  assert.equal(hit(middleware, { ip: '10.0.0.1' }).passed, false);
  assert.equal(hit(middleware, { ip: '10.0.0.2' }).passed, true);
});

test('trusted proxy hops are bounded and invalid configuration fails closed', () => {
  assert.equal(resolveTrustProxyHops(undefined), 0);
  assert.equal(resolveTrustProxyHops(' 1 '), 1);
  assert.equal(resolveTrustProxyHops('5'), 5);
  for (const value of ['-1', '6', '1.5', 'true', '1,2']) {
    assert.throws(() => resolveTrustProxyHops(value), /integer from 0 through 5/);
  }
});

test('new passwords stay within bcrypt input boundaries', () => {
  assert.match(passwordPolicyError('short') || '', /at least 8/);
  assert.equal(passwordPolicyError('correct horse battery staple'), null);
  assert.match(passwordPolicyError('x'.repeat(73)) || '', /72 UTF-8 bytes/);
  assert.match(passwordPolicyError('🔐'.repeat(19)) || '', /72 UTF-8 bytes/);
});

test('network CORS accepts only explicit and native-app origins', async () => {
  const check = corsOrigin(true);
  if (typeof check !== 'function') throw new Error('network CORS did not return an origin callback');
  const allowed = (origin: string | undefined) => new Promise<boolean>((resolve) => {
    check(origin, (error: Error | null, accepted?: boolean) => resolve(!error && accepted === true));
  });
  assert.equal(await allowed(undefined), true);
  assert.equal(await allowed('https://localhost'), true);
  assert.equal(await allowed('https://evil.example'), false);
});

function applySecurityHeaders(path: string, opts: { networkMode?: boolean; secure?: boolean } = {}) {
  const headers: Record<string, string> = {};
  let passed = false;
  const req = {
    path,
    secure: opts.secure ?? false,
    get: () => undefined,
  } as unknown as Request;
  const res = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
  } as unknown as Response;
  securityHeaders({ networkMode: opts.networkMode })(req, res, () => { passed = true; });
  return { headers, passed };
}

test('app responses receive restrictive browser headers and HTTPS gets HSTS', () => {
  const { headers, passed } = applySecurityHeaders('/app', {
    networkMode: true,
    secure: true,
  });
  assert.equal(passed, true);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['strict-transport-security'], /max-age=31536000/);
});

test('public note pages remain embeddable but retain a locked-down CSP', () => {
  const { headers } = applySecurityHeaders('/p/public-note', { networkMode: false });
  assert.equal(headers['x-frame-options'], undefined);
  assert.equal(headers['cross-origin-opener-policy'], undefined);
  assert.match(headers['content-security-policy'], /default-src 'none'/);
  assert.match(headers['content-security-policy'], /frame-ancestors \*/);
  assert.equal(headers['strict-transport-security'], undefined);
});
