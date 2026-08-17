import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEdgeProof } from './edge-limit-proof.mjs';

test('requires exactly 40 live sockets, a 429 overflow, and slot recovery', () => {
  assert.deepEqual(
    evaluateEdgeProof(
      { accepted: 40, acceptedStillOpen: 40, rejectedStatus: 429, retryAccepted: true },
      40,
      429,
    ),
    { ok: true, failures: [] },
  );
});

test('fails closed when the edge accepts overflow or does not recover capacity', () => {
  const evaluation = evaluateEdgeProof(
    { accepted: 40, acceptedStillOpen: 39, rejectedStatus: null, retryAccepted: false },
    40,
    429,
  );
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /39\/40/);
  assert.match(evaluation.failures.join('\n'), /expected 429/);
  assert.match(evaluation.failures.join('\n'), /replacement/);
});
