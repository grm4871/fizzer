const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

test('desktop startup paints a window before housekeeping and does not HEAD the hosted URL', () => {
  assert.doesNotMatch(source, /\bwaitForAppUrl\b|\bcanReachUrl\b/);
  assert.match(source, /backgroundColor: APP_BACKGROUND/);
  assert.match(source, /createWindow\(\);/);
  const createAt = source.indexOf('createWindow();');
  const reapAt = source.indexOf('void reapOrphanedLocalAgentRuns()');
  const pruneAt = source.indexOf('void worktrees.pruneWorkspaces()');
  assert.ok(createAt > 0 && reapAt > createAt && pruneAt > createAt);
});

test('desktop navigation and runner helpers are pinned to the main-process instance', () => {
  assert.match(source, /win\.webContents\.on\('will-navigate', guardNavigation\)/);
  assert.match(source, /win\.webContents\.on\('will-redirect', guardNavigation\)/);
  assert.match(source, /isSameOrigin\(apiUrl, INSTANCE_ORIGIN\)/);
  assert.match(source, /connectDesktopRunner\(token, INSTANCE_ORIGIN\)/);
  assert.doesNotMatch(source, /hostname\.endsWith\('\.cscd\.online'\)/);
});
