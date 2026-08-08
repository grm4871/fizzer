const assert = require('node:assert/strict');
const test = require('node:test');
const { probeLocalModelsAsync } = require('./desktop-runner-host.cjs');

test('model discovery is single-flight and never blocks Electron main', async () => {
  const originalPath = process.env.PATH;
  // Make provider probes fail immediately inside the worker; this test covers
  // scheduling and cache ownership, not whichever CLIs happen to be installed.
  process.env.PATH = '/cascade-test-no-binaries';
  try {
    const started = Date.now();
    const first = probeLocalModelsAsync({ force: true });
    const second = probeLocalModelsAsync();
    assert.equal(first, second);
    assert.ok(Date.now() - started < 100, 'starting discovery must not run probes inline');

    let mainTicked = false;
    setImmediate(() => { mainTicked = true; });
    let timeout;
    const models = await Promise.race([
      first,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('model probe worker timed out')), 5_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.equal(mainTicked, true);
    assert.equal(typeof models, 'object');
  } finally {
    process.env.PATH = originalPath;
  }
});
