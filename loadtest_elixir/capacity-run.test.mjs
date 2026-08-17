import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const controller = path.join(here, 'capacity-run.sh');
const imageId = `sha256:${'a'.repeat(64)}`;
const revision = '9'.repeat(40);
const containerId = 'b'.repeat(64);
const faultContainerId = 'e'.repeat(64);
const soakContainerId = 'f'.repeat(64);
const diagnosticContainerId = 'c'.repeat(64);

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o700 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-capacity-lock-test-'));
  const bin = path.join(root, 'bin');
  const template = path.join(root, 'template');
  const data = path.join(root, 'data');
  const faultData = path.join(root, 'fault-data');
  const soakData = path.join(root, 'soak-data');
  const sourceDatabase = path.join(root, 'source.db');
  const sourceCorpusRoot = path.join(root, 'source-corpus');
  const fixtureFile = path.join(root, 'fixtures.jsonl');
  const resultsDir = path.join(root, 'results');
  fs.mkdirSync(bin);
  fs.mkdirSync(template);
  fs.mkdirSync(sourceCorpusRoot);
  fs.writeFileSync(sourceDatabase, 'approved source database');
  fs.writeFileSync(path.join(sourceCorpusRoot, 'approved.txt'), 'approved corpus');
  fs.writeFileSync(fixtureFile, '{"fixture":"redacted"}\n');
  const initialized = spawnSync('sqlite3', [
    path.join(template, 'docs.db'),
    'PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY);',
  ], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const log = path.join(root, 'docker.log');
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const lock = path.join(root, 'capacity.lock');
  writeExecutable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
if [[ "$1 $2" == 'container inspect' ]]; then
  target="\${!#}"
  if [[ "$target" == "$FAKE_CONTAINER_NAME" ]]; then
    [[ "\${FAKE_EXACT_CONTAINER_EXISTS:-0}" == '1' ]] && exit 0
    exit 1
  fi
  state_file="$FAKE_DOCKER_STATE/$target"
  [[ -f "$state_file" ]] || exit 1
  IFS='|' read -r id owner phase name running started restart oom <"$state_file"
  printf '%s|%s|%s|/%s|%s|%s|%s|%s\\n' "$id" "$owner" "$phase" "$name" "$running" "$started" "$restart" "$oom"
elif [[ "$1 $2" == 'image inspect' ]]; then
  printf '%s|%s\n' "$FAKE_IMAGE_ID" "$FAKE_REVISION"
elif [[ "$1 $2" == 'container ls' ]]; then
  if [[ " $* " == *' -a '* ]]; then
    if [[ "\${FAKE_EXACT_CONTAINER_EXISTS:-0}" == '1' ]]; then
      printf 'dddddddddddd|%s\\n' "$FAKE_CONTAINER_NAME"
    fi
  elif [[ -n "\${FAKE_RUNNING_CONTAINER_NAME:-}" ]]; then
    printf 'cccccccccccc|%s|%s\\n' "$FAKE_RUNNING_CONTAINER_NAME" "\${FAKE_RUNNING_CONTAINER_OWNER:-}"
  fi
elif [[ "$1" == 'create' ]]; then
  cidfile=''
  owner=''
  phase=''
  name=''
  while (($#)); do
    case "$1" in
      --cidfile) cidfile="$2"; shift 2 ;;
      --name) name="$2"; shift 2 ;;
      --label)
        case "$2" in
          io.cascade.capacity-run-owner=*) owner="\${2#io.cascade.capacity-run-owner=}" ;;
          io.cascade.capacity-run-phase=*) phase="\${2#io.cascade.capacity-run-phase=}" ;;
        esac
        shift 2
        ;;
      *) shift ;;
    esac
  done
  case "$phase" in
    main10k) id="$FAKE_CONTAINER_ID" ;;
    faults) id="$FAKE_FAULT_CONTAINER_ID" ;;
    soak5k) id="$FAKE_SOAK_CONTAINER_ID" ;;
    diagnostic) id="$FAKE_DIAGNOSTIC_CONTAINER_ID" ;;
    *) exit 2 ;;
  esac
  printf '%s' "$id" >"$cidfile"
  printf '%s|%s|%s|%s|false|0001-01-01T00:00:00Z|0|false\\n' "$id" "$owner" "$phase" "$name" >"$FAKE_DOCKER_STATE/$id"
  printf '%s\\n' "$id"
elif [[ "$1 $2" == 'container start' ]]; then
  id="$3"
  state_file="$FAKE_DOCKER_STATE/$id"
  IFS='|' read -r id owner phase name _running _started restart oom <"$state_file"
  printf '%s|%s|%s|%s|true|2026-08-11T12:00:00Z|%s|%s\\n' "$id" "$owner" "$phase" "$name" "$restart" "$oom" >"$state_file"
elif [[ "$1 $2" == 'container stop' ]]; then
  id="\${!#}"
  state_file="$FAKE_DOCKER_STATE/$id"
  IFS='|' read -r id owner phase name _running started restart oom <"$state_file"
  printf '%s|%s|%s|%s|false|%s|%s|%s\\n' "$id" "$owner" "$phase" "$name" "$started" "$restart" "$oom" >"$state_file"
elif [[ "$1 $2 $3" == 'container rm -f' ]]; then
  rm -f "$FAKE_DOCKER_STATE/$4"
fi
`);
  writeExecutable(path.join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *' rev-parse HEAD '* ]]; then
  printf '%s\n' "$FAKE_GIT_REVISION"
elif [[ " $* " == *' status --porcelain --untracked-files=all '* ]]; then
  [[ "\${FAKE_GIT_DIRTY:-0}" == '0' ]] || printf ' M dirty\n'
  exit 0
else
  exit 2
fi
`);
  return {
    root, bin, template, data, faultData, soakData, sourceDatabase,
    sourceCorpusRoot, fixtureFile, resultsDir, log, state, lock,
  };
}

function environment(item) {
  return {
    ...process.env,
    PATH: `${item.bin}:${process.env.PATH}`,
    CAPACITY_RELEASE_COOKIE: 'test-release-cookie',
    CAPACITY_JWT_SECRET: 'test-jwt-secret',
    CASCADE_CAPACITY_TESTING: '1',
    CASCADE_CAPACITY_TEST_LOCK_FILE: item.lock,
    CASCADE_CAPACITY_GENERATOR_CPUSET: '2',
    FAKE_CONTAINER_ID: containerId,
    FAKE_FAULT_CONTAINER_ID: faultContainerId,
    FAKE_SOAK_CONTAINER_ID: soakContainerId,
    FAKE_DIAGNOSTIC_CONTAINER_ID: diagnosticContainerId,
    FAKE_CONTAINER_NAME: 'cascade-elixir-capacity',
    FAKE_IMAGE_ID: imageId,
    FAKE_REVISION: revision,
    FAKE_GIT_REVISION: revision,
    FAKE_DOCKER_LOG: item.log,
    FAKE_DOCKER_STATE: item.state,
  };
}

function checkedInControllerOptions(item, overrides = {}) {
  const values = {
    sourceDatabase: item.sourceDatabase,
    sourceCorpusRoot: item.sourceCorpusRoot,
    fixture: item.fixtureFile,
    resultsDir: item.resultsDir,
    ...overrides,
  };
  return [
    '--profile', 'final10k',
    '--image', `cascade:certified-${revision}`,
    '--image-id', imageId,
    '--revision', revision,
    '--source-database', values.sourceDatabase,
    '--source-corpus-root', values.sourceCorpusRoot,
    '--fixture', values.fixture,
    '--results-dir', values.resultsDir,
    '--source-ip', '127.0.0.2', '--source-ip', '127.0.0.3',
    '--source-ip', '127.0.0.4', '--source-ip', '127.0.0.5',
    '--soak-source-ip', '127.0.0.6',
    '--fixture-prefix', 'capacity',
  ];
}

function args(item, command, suffix = '') {
  const data = suffix ? `${item.data}-${suffix}` : item.data;
  const faultData = suffix ? `${item.faultData}-${suffix}` : item.faultData;
  const soakData = suffix ? `${item.soakData}-${suffix}` : item.soakData;
  return [
    controller,
    '--profile', 'final10k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', data,
    '--fault-data-dir', faultData,
    '--soak-data-dir', soakData,
    '--', ...command,
  ];
}

function diagnosticArgs(item, command, suffix = '') {
  const data = suffix ? `${item.data}-${suffix}` : item.data;
  return [
    controller,
    '--profile', 'diagnostic1k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', data,
    '--', ...command,
  ];
}

function waitFor(file, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 20);
    };
    poll();
  });
}

test('holds the lock for the full command and a second run fails before Docker access', async (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const ready = path.join(item.root, 'ready');
  const release = path.join(item.root, 'release');
  const childSource = `
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], 'ready');
    const timer = setInterval(() => {
      if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.exit(0); }
    }, 20);
  `;
  const first = spawn('bash', args(item, [process.execPath, '-e', childSource, ready, release]), {
    env: environment(item), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstError = '';
  first.stderr.on('data', (chunk) => { firstError += chunk; });
  await waitFor(ready);
  const before = fs.readFileSync(item.log, 'utf8');

  const second = spawnSync('bash', args(item, [process.execPath, '-e', 'process.exit(0)'], 'second'), {
    env: environment(item), encoding: 'utf8', timeout: 2_000,
  });
  assert.equal(second.status, 75);
  assert.match(second.stderr, /Docker was not touched/);
  assert.equal(fs.readFileSync(item.log, 'utf8'), before);

  fs.writeFileSync(release, 'release');
  const firstStatus = await new Promise((resolve) => first.on('exit', resolve));
  assert.equal(firstStatus, 0, firstError);
});

test('cleanup targets only the exact container ID recorded and owned by this run', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', `
    if (!/^[a-f0-9]{64}$/.test(process.env.CASCADE_CAPACITY_CONTAINER_ID)) process.exit(2);
    if (!process.env.CASCADE_CAPACITY_CONTAINER_NAME.startsWith('cascade-elixir-capacity')) process.exit(3);
  `]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.equal(lines.at(-1), `container rm -f ${containerId}`);
  assert.ok(!lines.some((line) => /container rm -f cascade-elixir-capacity/u.test(line)));
});

test('cleanup refuses a container whose ownership label changed', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', `
    const fs = require('node:fs');
    if (process.env.CASCADE_CAPACITY_PHASE === 'certify') {
      const state = process.env.FAKE_DOCKER_STATE + '/' + process.env.CASCADE_CAPACITY_CONTAINER_ID;
      fs.writeFileSync(state, '${containerId}|another-run|main10k|cascade-elixir-capacity|false|2026-08-11T12:00:00Z|0|false\\n');
    }
  `]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ownership no longer matches/);
  assert.ok(!fs.readFileSync(item.log, 'utf8').includes(`container rm -f ${containerId}`));
});

test('cleanup fails if the recorded owned container disappeared', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', `
    const fs = require('node:fs');
    if (process.env.CASCADE_CAPACITY_PHASE === 'certify') {
      fs.rmSync(process.env.FAKE_DOCKER_STATE + '/' + process.env.CASCADE_CAPACITY_CONTAINER_ID);
    }
  `]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not inspect owned main10k capacity container/);
  assert.ok(!fs.readFileSync(item.log, 'utf8').includes(`container rm -f ${containerId}`));
});

test('preflight completes before the exact owned ID starts and run phase begins', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const phases = path.join(item.root, 'phases');
  const result = spawnSync('bash', args(item, [process.execPath, '-e', `
    const fs = require('node:fs');
    fs.appendFileSync(process.argv[1], process.env.CASCADE_CAPACITY_PHASE + '\\n');
  `, phases]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(phases, 'utf8').trim().split('\n'), [
    'preflight-main10k',
    'run-main10k',
    'reconcile-main10k',
    'preflight-faults',
    'run-faults',
    'freeze-faults',
    'preflight-soak5k',
    'run-soak5k',
    'freeze-soak5k',
    'certify',
  ]);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  const createIndex = lines.findIndex((line) => line.startsWith('create '));
  const startIndex = lines.indexOf(`container start ${containerId}`);
  const removeIndex = lines.indexOf(`container rm -f ${containerId}`);
  assert.ok(createIndex >= 0 && createIndex < startIndex && startIndex < removeIndex);
});

test('preflight failure never starts the candidate and cleans only the owned ID', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', `
    if (process.env.CASCADE_CAPACITY_PHASE === 'preflight-main10k') process.exit(17);
  `]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 17, result.stderr);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.ok(lines.some((line) => line.startsWith('create ')));
  assert.ok(!lines.some((line) => line.startsWith('container start ')));
  assert.equal(lines.at(-1), `container rm -f ${containerId}`);
});

test('diagnostic1k is one locked frozen candidate and cannot enter final certification phases', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const evidence = path.join(item.root, 'diagnostic-phases.jsonl');
  const result = spawnSync('bash', diagnosticArgs(item, [process.execPath, '-e', `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const database = process.env.CASCADE_CAPACITY_DATA_DIR + '/docs.db';
    const phase = process.env.CASCADE_CAPACITY_PHASE;
    const record = {
      phase,
      containerId: process.env.CASCADE_CAPACITY_CONTAINER_ID,
      databaseSha256: process.env.CASCADE_CAPACITY_DATABASE_SHA256 || null,
      sidecarsAbsent: !fs.existsSync(database + '-wal') && !fs.existsSync(database + '-shm'),
    };
    if (phase === 'freeze-diagnostic') {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(database)).digest('hex');
      if (record.databaseSha256 !== actual || !record.sidecarsAbsent) process.exit(41);
    }
    fs.appendFileSync(process.argv[1], JSON.stringify(record) + '\\n');
  `, evidence]), { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const phases = fs.readFileSync(evidence, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(phases.map((entry) => entry.phase), [
    'preflight-diagnostic', 'run-diagnostic', 'freeze-diagnostic',
  ]);
  assert.ok(phases.every((entry) => entry.containerId === diagnosticContainerId));
  assert.equal(phases.at(-1).sidecarsAbsent, true);
  assert.match(phases.at(-1).databaseSha256, /^[a-f0-9]{64}$/u);
  const dockerLines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.ok(dockerLines.includes(`container start ${diagnosticContainerId}`));
  assert.ok(dockerLines.some((line) => line.startsWith(`container stop --time 30 ${diagnosticContainerId}`)));
  assert.equal(dockerLines.at(-1), `container rm -f ${diagnosticContainerId}`);
  assert.ok(!dockerLines.some((line) => line.includes(faultContainerId) || line.includes(soakContainerId)));
});

test('diagnostic1k rejects final-only phase roots before Docker access', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', [
    controller,
    '--profile', 'diagnostic1k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', item.data,
    '--fault-data-dir', item.faultData,
    '--soak-data-dir', item.soakData,
    '--', process.execPath, '-e', 'process.exit(0)',
  ], { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /cannot enter final phase roots/);
  assert.equal(fs.existsSync(item.log), false);
});

test('production entrypoint treats post-separator text only as checked-in runner options', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const injected = path.join(item.root, 'injected-controller');
  const injectionMarker = path.join(item.root, 'injection-ran');
  writeExecutable(injected, `#!/usr/bin/env bash\nprintf injected >"${injectionMarker}"\n`);
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  const result = spawnSync('bash', args(item, [injected, ...checkedInControllerOptions(item)]), {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /only checked-in controller options/u);
  assert.equal(fs.existsSync(injectionMarker), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('production boundary accepts distinct immutable template and source roots', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  writeExecutable(path.join(item.bin, 'node'), '#!/usr/bin/env bash\nexit 0\n');
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item)), {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /immutable input directories must be distinct/u);
});

test('mutable data nested in the template fails before Docker, mkdir, or copy', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const nestedData = path.join(item.template, 'nested-candidate');
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  const argv = [
    controller,
    '--profile', 'final10k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', nestedData,
    '--fault-data-dir', item.faultData,
    '--soak-data-dir', item.soakData,
    '--', ...checkedInControllerOptions(item),
  ];
  const beforeTemplate = fs.readdirSync(item.template).sort();
  const result = spawnSync('bash', argv, { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /disjoint from immutable input directories/u);
  assert.deepEqual(fs.readdirSync(item.template).sort(), beforeTemplate);
  assert.equal(fs.existsSync(nestedData), false);
  assert.equal(fs.existsSync(item.faultData), false);
  assert.equal(fs.existsSync(item.soakData), false);
  assert.equal(fs.existsSync(item.resultsDir), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('results nested in approved corpus fail before Docker or immutable-input mutation', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const nestedResults = path.join(item.sourceCorpusRoot, 'capacity-results');
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  const corpusBefore = fs.readdirSync(item.sourceCorpusRoot).sort();
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item, {
    resultsDir: nestedResults,
  })), { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /disjoint from immutable input directories/u);
  assert.deepEqual(fs.readdirSync(item.sourceCorpusRoot).sort(), corpusBefore);
  assert.equal(fs.existsSync(nestedResults), false);
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.faultData), false);
  assert.equal(fs.existsSync(item.soakData), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('mutable data nested in the checkout fails before Docker or checkout mutation', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const checkoutRoot = path.dirname(here);
  const nestedData = path.join(checkoutRoot, `.capacity-data-${path.basename(item.root)}`);
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  assert.equal(fs.existsSync(nestedData), false);
  const result = spawnSync('bash', [
    controller,
    '--profile', 'final10k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', nestedData,
    '--fault-data-dir', item.faultData,
    '--soak-data-dir', item.soakData,
    '--', ...checkedInControllerOptions(item),
  ], { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /disjoint from immutable input directories/u);
  assert.equal(fs.existsSync(nestedData), false);
  assert.equal(fs.existsSync(item.faultData), false);
  assert.equal(fs.existsSync(item.soakData), false);
  assert.equal(fs.existsSync(item.resultsDir), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('results nested in the checkout fail before Docker or checkout mutation', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const checkoutRoot = path.dirname(here);
  const nestedResults = path.join(checkoutRoot, `.capacity-results-${path.basename(item.root)}`);
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  assert.equal(fs.existsSync(nestedResults), false);
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item, {
    resultsDir: nestedResults,
  })), { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /disjoint from immutable input directories/u);
  assert.equal(fs.existsSync(nestedResults), false);
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.faultData), false);
  assert.equal(fs.existsSync(item.soakData), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('immutable source and fixture files cannot be hidden inside template/corpus trees', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const nestedFixture = path.join(item.sourceCorpusRoot, 'fixtures.jsonl');
  fs.writeFileSync(nestedFixture, '{}\n');
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item, {
    fixture: nestedFixture,
  })), { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /input files must not be nested/u);
  assert.equal(fs.readFileSync(nestedFixture, 'utf8'), '{}\n');
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.log), false);
});

test('dirty checkout fails before Docker or candidate data mutation', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  env.FAKE_GIT_DIRTY = '1';
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item)), {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 65);
  assert.match(result.stderr, /requires a clean checkout/u);
  assert.equal(fs.existsSync(item.log), false);
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.resultsDir), false);
});

test('canonical image tag must resolve to the exact wrapper image ID before clone/create', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  env.FAKE_IMAGE_ID = `sha256:${'7'.repeat(64)}`;
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item)), {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /image tag\/ID\/revision evidence does not match/u);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.ok(lines.some((line) => line.startsWith(`image inspect cascade:certified-${revision} `)));
  assert.ok(!lines.some((line) => line.startsWith('create ')));
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.resultsDir), false);
});

test('OCI revision label must equal requested clean HEAD before clone/create', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const env = environment(item);
  delete env.CASCADE_CAPACITY_TESTING;
  delete env.CASCADE_CAPACITY_TEST_LOCK_FILE;
  env.XDG_RUNTIME_DIR = item.root;
  env.FAKE_REVISION = '8'.repeat(40);
  const result = spawnSync('bash', args(item, checkedInControllerOptions(item)), {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /image tag\/ID\/revision evidence does not match/u);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.ok(!lines.some((line) => line.startsWith('create ')));
  assert.equal(fs.existsSync(item.data), false);
  assert.equal(fs.existsSync(item.resultsDir), false);
});

test('a running reserved sibling fails before any Docker mutation', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', 'process.exit(0)']), {
    env: { ...environment(item), FAKE_RUNNING_CONTAINER_NAME: 'cascade-elixir-capacity-1k' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /foreign state; refusing concurrent Docker mutation/);
  const lines = fs.readFileSync(item.log, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['container ls --format {{.ID}}|{{.Names}}|{{.Label "io.cascade.capacity-run-owner"}}']);
});

test('a stopped exact-name container is never adopted or removed', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', args(item, [process.execPath, '-e', 'process.exit(0)']), {
    env: { ...environment(item), FAKE_EXACT_CONTAINER_EXISTS: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /refusing to modify foreign capacity state/);
  assert.ok(!fs.readFileSync(item.log, 'utf8').split('\n').some((line) => line.startsWith('create ')));
  assert.ok(!fs.readFileSync(item.log, 'utf8').includes('container rm'));
});

test('a symlinked lock is rejected before Docker access', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const target = path.join(item.root, 'lock-target');
  fs.writeFileSync(target, '', { mode: 0o600 });
  fs.symlinkSync(target, item.lock);
  const result = spawnSync('bash', args(item, [process.execPath, '-e', 'process.exit(0)']), {
    env: environment(item), encoding: 'utf8',
  });
  assert.equal(result.status, 73);
  assert.match(result.stderr, /lock is not a regular file/);
  assert.equal(fs.existsSync(item.log), false);
});

test('a capacity run cannot escape sibling detection with an unrelated name', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const result = spawnSync('bash', [
    controller,
    '--profile', 'final10k',
    '--image', imageId,
    '--data-template-dir', item.template,
    '--data-dir', item.data,
    '--fault-data-dir', item.faultData,
    '--soak-data-dir', item.soakData,
    '--container', 'untracked-diagnostic',
    '--', process.execPath, '-e', 'process.exit(0)',
  ], { env: environment(item), encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /reserved cascade-elixir-capacity namespace/);
  assert.equal(fs.existsSync(item.log), false);
});

test('controller and workload affinity reject candidate CPUs 0-1 before Docker access', (t) => {
  const item = fixture();
  t.after(() => fs.rmSync(item.root, { recursive: true, force: true }));
  const affinity = path.join(item.root, 'affinity');
  const accepted = spawnSync('bash', args(item, [process.execPath, '-e', `
    const fs = require('node:fs');
    const allowed = fs.readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\\s*(.+)$/m)[1];
    fs.writeFileSync(process.argv[1], allowed);
  `, affinity]), { env: environment(item), encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(fs.readFileSync(affinity, 'utf8'), '2');

  const rejected = spawnSync('bash', args(item, [process.execPath, '-e', 'process.exit(0)']), {
    env: {
      ...environment(item),
      CASCADE_CAPACITY_AFFINITY_BOUND: '0',
      CASCADE_CAPACITY_GENERATOR_CPUSET: '0-2',
    },
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 64);
  assert.match(rejected.stderr, /must exclude candidate CPUs 0-1/);

  const dockerBeforeForgedMarker = fs.readFileSync(item.log, 'utf8');
  const forged = spawnSync('taskset', [
    '-c', '2-3',
    'bash', ...args(item, [process.execPath, '-e', 'process.exit(0)']),
  ], {
    env: {
      ...environment(item),
      CASCADE_CAPACITY_AFFINITY_BOUND: '1',
      CASCADE_CAPACITY_GENERATOR_CPUSET: '2',
    },
    encoding: 'utf8',
  });
  assert.equal(forged.status, 70);
  assert.match(forged.stderr, /controller affinity 2-3 does not match requested generator CPUs 2/);
  assert.equal(fs.readFileSync(item.log, 'utf8'), dockerBeforeForgedMarker);
});

test('capacity scripts contain no broad name-filter cleanup path', () => {
  const scriptDirectories = [here, path.join(here, '..', 'deploy')];
  for (const directory of scriptDirectories) {
    const scriptFiles = fs.readdirSync(directory)
      .filter((name) => /\.(?:mjs|sh)$/u.test(name));
    for (const name of scriptFiles) {
      const label = path.relative(path.join(here, '..'), path.join(directory, name));
      const source = fs.readFileSync(path.join(directory, name), 'utf8');
      assert.doesNotMatch(source, /--filter(?:=|\s+)["']?name[^\n]*cascade-elixir-capacity/u, label);
      assert.doesNotMatch(source, /docker\s+(?:container\s+)?rm\s+-[^\n]*\$\{?container(?:_name)?\}?/u, label);
    }
  }
});

test('the root release command makes the locked controller the checked-in entrypoint', () => {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.equal(rootPackage.scripts['release:capacity:run'], 'bash loadtest_elixir/capacity-run.sh');
  const wrapper = fs.readFileSync(controller, 'utf8');
  assert.match(wrapper, /controller_command=\(node "\$controller_script"/u);
  assert.match(wrapper, /certification-runner\.mjs/u);
  const telemetry = fs.readFileSync(path.join(here, 'CAPACITY_TELEMETRY.md'), 'utf8');
  assert.match(telemetry, /npm run release:capacity:run --/u);
  assert.match(telemetry, /--\s*\\\n\s*--profile final10k/u);
  assert.match(telemetry, /--\s*\\\n\s*--profile diagnostic1k/u);
  assert.doesNotMatch(telemetry, /run-all-certification|site-owned orchestration/u);
  assert.doesNotMatch(telemetry, /\ndocker run\s/u);
});
