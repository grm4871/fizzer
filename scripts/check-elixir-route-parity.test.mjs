import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRoutes, extractElixirRoutes } from './check-elixir-route-parity.mjs';

test('extracts Plug route macros with their source locations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-elixir-routes-'));
  try {
    fs.writeFileSync(path.join(directory, 'router.ex'), `
      defmodule Example do
        get "/api/health", do: :ok
        post "/api/vaults/:id/notes", do: :ok
        match "/api/*path", do: :ignored
        # parity-route GET *
      end
    `);
    assert.deepEqual(
      extractElixirRoutes(directory).map(({ method, path: routePath }) => [method, routePath]),
      [
        ['GET', '/api/health'],
        ['POST', '/api/vaults/:id/notes'],
        ['GET', '*'],
      ],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed on missing, unexpected, and duplicate contracts', () => {
  const result = compareRoutes(
    [
      { method: 'GET', path: '/api/health' },
      { method: 'POST', path: '/api/vaults' },
    ],
    [
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/api/health' },
      { method: 'DELETE', path: '/api/extra' },
    ],
  );
  assert.deepEqual(result.missing, ['POST /api/vaults']);
  assert.deepEqual(result.unexpected, ['DELETE /api/extra']);
  assert.deepEqual(result.duplicates, ['GET /api/health']);
});

test('treats framework-local parameter names as the same external route', () => {
  const result = compareRoutes(
    [{ method: 'DELETE', path: '/api/vaults/:id/members/:userId' }],
    [{ method: 'DELETE', path: '/api/vaults/:vault_id/members/:user_id' }],
  );
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
});

test('retains a parameter suffix as part of the external route', () => {
  const result = compareRoutes(
    [
      { method: 'GET', path: '/p/:slug' },
      { method: 'GET', path: '/p/:slug.json' },
    ],
    [
      { method: 'GET', path: '/p/:name' },
      { method: 'GET', path: '/p/:name.json' },
    ],
  );
  assert.equal(result.requiredCount, 2);
  assert.deepEqual(result.missing, []);
});
