import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cascade-note');

test('regular notes can be renamed and deleted by title', async (t) => {
  const requests = [];
  let title = 'Old title';
  const note = () => ({
    id: 'note-1',
    vault_id: 'vault-1',
    title,
    content: 'Body',
  });

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body: body ? JSON.parse(body) : null,
    });

    res.setHeader('content-type', 'application/json');
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pathname === '/api/vaults/vault-1/notes') {
      // Mirror the server-side title filters the CLI relies on.
      const exact = searchParams.get('title');
      const partial = searchParams.get('title_contains');
      const matches = [note()].filter((n) => {
        if (exact !== null) return n.title.toLowerCase() === exact.toLowerCase();
        if (partial !== null) return n.title.toLowerCase().includes(partial.toLowerCase());
        return true;
      });
      res.end(JSON.stringify({ notes: matches }));
    } else if (req.method === 'GET' && req.url === '/api/notes/note-1') {
      res.end(JSON.stringify({ note: note() }));
    } else if (req.method === 'POST' && req.url === '/api/notes/note-1/rename') {
      title = JSON.parse(body).title;
      res.end(JSON.stringify({ note: note() }));
    } else if (req.method === 'DELETE' && req.url === '/api/notes/note-1') {
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === 'object');
  const targetArgs = [
    '--url',
    `http://127.0.0.1:${address.port}`,
    '--token',
    'test-token',
    '--vault',
    'vault-1',
  ];

  const renamed = await execFileAsync(process.execPath, [
    cli,
    'rename',
    'Old title',
    '--title',
    'New title',
    '--json',
    ...targetArgs,
  ]);
  assert.equal(JSON.parse(renamed.stdout).title, 'New title');

  const deleted = await execFileAsync(process.execPath, [
    cli,
    'delete',
    'New title',
    '--json',
    ...targetArgs,
  ]);
  assert.deepEqual(JSON.parse(deleted.stdout), {
    ok: true,
    note: note(),
  });

  assert.deepEqual(
    requests.map(({ method, url }) => `${method} ${url}`),
    [
      'GET /api/vaults/vault-1/notes?title=Old%20title',
      'POST /api/notes/note-1/rename',
      'GET /api/vaults/vault-1/notes?title=New%20title',
      'GET /api/notes/note-1',
      'DELETE /api/notes/note-1',
    ],
  );
  assert.deepEqual(requests[1].body, { title: 'New title' });
});
