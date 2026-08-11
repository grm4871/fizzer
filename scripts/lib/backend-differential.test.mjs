import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clusterBackendDifferences,
  compareBackendResults,
  diffValues,
  normalizeHeaders,
  normalizeValue,
} from './backend-differential.mjs';

test('normalizer removes only documented runtime nondeterminism', () => {
  const normalized = normalizeValue({
    id: '9d126ffc-0e9a-4d65-bc83-c58d90fe3e14',
    agentId: 'codex',
    token: 'header.payload.signature',
    createdAt: '2026-08-10T12:34:56.789Z',
    url: 'http://127.0.0.1:40123/p/Mf0xKYiYq3CXEYuRlH2Jhw',
    title: 'Keep this exact',
  });
  assert.deepEqual(normalized, {
    agentId: 'codex', createdAt: '<timestamp>', id: '<id>', title: 'Keep this exact',
    token: '<token>', url: '<origin>/p/<token>',
  });
});

test('public slugs embedded in rendered HTML normalize as opaque tokens', () => {
  assert.equal(
    normalizeValue('<meta property="og:url" content="http://127.0.0.1:4000/p/Mf0xKYiYq3CXEYuRlH2Jhw">'),
    '<meta property="og:url" content="<origin>/p/<token>">',
  );
  assert.equal(
    normalizeValue('href="http%3A%2F%2F127.0.0.1%3A4000%2Fp%2FMf0xKYiYq3CXEYuRlH2Jhw"'),
    'href="<origin>%2Fp%2F<token>"',
  );
});

test('JSON database payloads normalize recursively', () => {
  assert.deepEqual(
    normalizeValue({ payload_json: '{"runId":7,"status":"completed"}' }),
    { payload_json: { runId: '<id>', status: 'completed' } },
  );
});

test('header normalizer retains security/cache semantics and hides cookie values', () => {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': 'cascade_session=abc; Path=/; HttpOnly; SameSite=Lax',
    'x-content-type-options': 'nosniff',
  });
  const normalized = normalizeHeaders(headers);
  assert.equal(normalized['set-cookie'], 'cascade_session=<token>; Path=/; HttpOnly; SameSite=Lax');
  assert.equal(normalized['x-content-type-options'], 'nosniff');
  assert.equal(normalized['content-type'], 'application/json; charset=utf-8');
});

test('comparator accepts different ids and timestamps but rejects value drift', () => {
  assert.equal(compareBackendResults(
    { status: 201, body: { id: 1, created_at: '2026-08-10 12:00:00', role: 'owner' } },
    { status: 201, body: { id: 9, created_at: '2026-08-10 12:00:01', role: 'owner' } },
  ).ok, true);
  const mismatch = compareBackendResults(
    { status: 201, body: { role: 'owner' } },
    { status: 200, body: { role: 'editor' } },
  );
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diffs.some((diff) => diff.includes('role')));
  assert.ok(mismatch.diffs.some((diff) => diff.includes('status')));
});

test('diff output includes actionable JSON paths and array lengths', () => {
  const diffs = diffValues({ events: ['a'], html: 'same\nnode' }, { events: ['a', 'b'], html: 'same\nelixir' });
  assert.ok(diffs.some((diff) => diff.includes('$["events"].length')));
  assert.ok(diffs.some((diff) => diff.includes('$["html"] line 2')));
});

test('difference clustering retains every mismatch and fails closed on unknown paths', () => {
  const diffs = [
    '$["transcript"][5]["body"]["vault"]["visibility"]: missing on elixir',
    '$["database"]["tables"]["chat_messages"]["columns"][1]: values differ',
    '$["unexpected"]: true !== false',
  ];
  const transcript = Array.from({ length: 6 }, (_, index) => ({ label: `step-${index}` }));
  transcript[5].label = 'vault.create';
  const clusters = clusterBackendDifferences(diffs, transcript);
  assert.equal(clusters.reduce((count, cluster) => count + cluster.count, 0), diffs.length);
  assert.deepEqual(clusters.find((cluster) => cluster.id === 'vault-public-shape').affectedHttpSteps, ['vault.create']);
  assert.equal(clusters.find((cluster) => cluster.id === 'unclassified-contract-gap').classification, 'contract-gap');
});
