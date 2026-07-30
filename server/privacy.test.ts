import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAgentApiRequestAllowed,
  privateBlocks,
  redactPrivateBlocks,
  redactPrivateBlocksForPublic,
  redactPrivatePreview,
  restoreAgentPrivateBlocks,
  sanitizeAgentJson,
} from './privacy.js';

const source = [
  '# Service',
  '',
  'Public instructions.',
  '',
  ':::private',
  'API_KEY=super-secret',
  ':::',
  '',
  'Public tail.',
].join('\n');

test('privacy blocks redact for agents and public snapshots', () => {
  const blocks = privateBlocks(source);
  assert.equal(blocks.length, 1);
  const agent = redactPrivateBlocks(source);
  assert.doesNotMatch(agent, /super-secret/);
  assert.match(agent, /Private block hidden from agents\. id=p/);
  assert.match(agent, /Public instructions/);
  assert.match(agent, /Public tail/);

  const publicCopy = redactPrivateBlocksForPublic(source);
  assert.doesNotMatch(publicCopy, /super-secret|hidden from agents/);
  assert.match(publicCopy, /Private block omitted from the public note/);
  assert.equal(redactPrivateBlocks(agent), agent, 'redaction is idempotent');
});

test('unterminated privacy blocks fail closed', () => {
  const redacted = redactPrivateBlocks('visible\n:::private\nsecret\nstill secret');
  assert.match(redacted, /^visible/);
  assert.doesNotMatch(redacted, /secret/);
});

test('collapsed note previews fail closed after a private opener', () => {
  assert.equal(
    redactPrivatePreview('public :::private API_KEY=super-secret ::: public tail'),
    'public [Private block hidden from agents]',
  );
  assert.doesNotMatch(
    JSON.stringify(sanitizeAgentJson({ content_preview: ':::private API_KEY=super-secret :::' })),
    /super-secret/,
  );
});

test('agent edits preserve existing private blocks without seeing them', () => {
  const redacted = redactPrivateBlocks(source);
  const edited = redacted.replace('Public tail.', 'Updated public tail.');
  const restored = restoreAgentPrivateBlocks(source, edited);
  assert.match(restored, /API_KEY=super-secret/);
  assert.match(restored, /Updated public tail/);

  assert.throws(
    () => restoreAgentPrivateBlocks(source, edited.replace(/^:::private[\s\S]*?^:::\n?/m, '')),
    /preserve every private block placeholder/,
  );
  assert.throws(
    () => restoreAgentPrivateBlocks(source, `${edited}\n${redacted.match(/:::private[\s\S]*?:::/)?.[0]}`),
    /preserve every private block placeholder/,
  );
});

test('agent JSON redaction is recursive', () => {
  const result = sanitizeAgentJson({
    note: { content: source },
    versions: [{ diff: source }],
  });
  assert.doesNotMatch(JSON.stringify(result), /super-secret/);
});

test('agent API capabilities allow helpers but deny user and publishing routes', () => {
  assert.equal(isAgentApiRequestAllowed('GET', '/api/vaults'), true);
  assert.equal(isAgentApiRequestAllowed('GET', '/api/notes/n1'), true);
  assert.equal(isAgentApiRequestAllowed('PUT', '/api/notes/n1'), true);
  assert.equal(isAgentApiRequestAllowed('POST', '/api/vaults/v1/channels/c1/messages'), true);
  assert.equal(isAgentApiRequestAllowed('POST', '/api/vaults/v1/scratchpad/journal'), true);
  assert.equal(isAgentApiRequestAllowed('PATCH', '/api/vaults/v1/channels/c1/messages/m1'), true);

  assert.equal(isAgentApiRequestAllowed('POST', '/api/auth/password'), false);
  assert.equal(isAgentApiRequestAllowed('GET', '/api/admin/users'), false);
  assert.equal(isAgentApiRequestAllowed('GET', '/api/notes/n1/diff'), false);
  assert.equal(isAgentApiRequestAllowed('POST', '/api/notes/n1/publish'), false);
  assert.equal(isAgentApiRequestAllowed('POST', '/api/vaults/v1/runs'), false);
});
