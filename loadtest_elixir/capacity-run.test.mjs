import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const controller = path.join(here, 'capacity-run.sh');

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
