import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  agentChatContentFromAccumulator,
  appendAgentChatRunEvents,
  buildAgentChannelWorkspaceContext,
  buildAgentChatContentFromRunEvents,
  buildAgentChatContext,
  CASCADE_AGENT_APP_CONTEXT,
  createAgentChatContentAccumulator,
} from './chat.js';

test('the app contract identifies Cascade and the live note helper unambiguously', () => {
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Obsidian-style workspace for AI-native project management/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /live app data, not a mirror/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Use `cascade-note` by command name/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /pre-authorized/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /`--listed` and `--folder`/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Do not replace the helper with an absolute path/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /absent from the local filesystem or named tool list/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Never claim you cannot see\/receive an attachment/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Push is not ship/);
  assert.match(CASCADE_AGENT_APP_CONTEXT, /Do not ignore a red deploy/);
});

test('chat agents inherit folder ancestry and the nearest project doc', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE folders (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      folder_id TEXT,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run('projects', 'vault', null, 'projects');
  db.prepare('INSERT INTO folders (id, vault_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run('oc', 'vault', 'projects', 'OC');
  const insertNote = db.prepare(`
    INSERT INTO notes (id, vault_id, folder_id, title, content)
    VALUES (?, 'vault', ?, ?, ?)
  `);
  insertNote.run('channel', 'oc', 'cubegen', 'cascade://chat-channel');
  insertNote.run(
    'project-doc',
    'oc',
    'Project — obsidiancube',
    'ObsidianCube is the umbrella project for the tools in this folder.\n\n:::private\nPROJECT_TOKEN=never-inject-me\n:::',
  );
  insertNote.run('nearby', 'oc', 'Meeting notes', 'This should not be injected.');

  const context = buildAgentChannelWorkspaceContext(db, 'channel');

  assert.match(context, /Cascade channel location: projects \/ OC \/ #cubegen/);
  assert.match(context, /Project — obsidiancube/);
  assert.match(context, /ObsidianCube is the umbrella project/);
  assert.match(context, /Private block hidden from agents/);
  assert.doesNotMatch(context, /never-inject-me/);
  assert.doesNotMatch(context, /This should not be injected/);
  db.close();
});

test('injected chat history names attachments and how to open them', () => {
  const message = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
    id, channelId: 'c', author: 'asdfasdf', body, createdAt: id, ...extra,
  }) as never;
  const context = buildAgentChatContext([
    message('m1', '', { hasImages: true }),
    message('m2', 'this also seems like a failure', { images: ['data:image/png;base64,AAAA'] }),
    message('m3', 'plain text'),
  ]);
  // A media-only message used to be filtered out for having an empty body.
  assert.match(context, /m1/);
  assert.match(context, /\[attached: 1 image — message m2\]/);
  assert.match(context, /cascade-chat attachment --message-id <id>/);
  assert.match(context, /Do not claim you cannot see the attachment/);
  assert.doesNotMatch(context, /plain text \[attached/);
});

test('history with no media carries no attachment hint', () => {
  const context = buildAgentChatContext([
    { id: 'm1', channelId: 'c', author: 'a', body: 'hello', createdAt: 'm1' },
  ] as never);
  assert.equal(context, 'a: hello');
});

test('only explicitly assistant-visible run text streams into a running chat message', () => {
  const event = (payload: Record<string, unknown>) => ({
    type: 'text',
    payload_json: JSON.stringify(payload),
  });
  const hidden = buildAgentChatContentFromRunEvents([
    event({ message: { content: [{ type: 'text', text: 'internal progress' }] } }),
  ]);
  assert.equal(hidden.body, 'Thinking...');

  const visible = buildAgentChatContentFromRunEvents([
    event({ chatVisible: true, message: { content: [{ type: 'text', text: 'I am checking that now.' }] } }),
  ]);
  assert.equal(visible.body, 'I am checking that now.');
  assert.equal(visible.status, 'running');
});

test('a terminal summary still replaces streamed progress', () => {
  const content = buildAgentChatContentFromRunEvents([
    {
      type: 'text',
      payload_json: JSON.stringify({
        chatVisible: true,
        message: { content: [{ type: 'text', text: 'I am checking that now.' }] },
      }),
    },
    {
      type: 'status',
      payload_json: JSON.stringify({ status: 'completed', summary: 'The fix is verified.' }),
    },
  ]);
  assert.equal(content.body, 'The fix is verified.');
  assert.equal(content.done, true);
});

test('incremental run projection matches a one-shot fold', () => {
  const events = [
    {
      type: 'harness',
      payload_json: JSON.stringify({ data: 'first\n' }),
    },
    {
      type: 'text',
      payload_json: JSON.stringify({
        chatVisible: true,
        message: { content: [{ type: 'text', text: 'Working.' }] },
      }),
    },
    {
      type: 'harness',
      payload_json: JSON.stringify({ data: 'second\n' }),
    },
    {
      type: 'status',
      payload_json: JSON.stringify({ status: 'completed', summary: 'Finished.' }),
    },
  ];
  const first = appendAgentChatRunEvents(createAgentChatContentAccumulator(), events.slice(0, 2));
  const incremental = agentChatContentFromAccumulator(appendAgentChatRunEvents(first, events.slice(2)));
  assert.deepEqual(incremental, buildAgentChatContentFromRunEvents(events));
  assert.equal(incremental.harnessLog, 'first\nsecond\n');
});
