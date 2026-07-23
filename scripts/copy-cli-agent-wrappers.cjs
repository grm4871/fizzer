#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'cli-agents');
const targetDir = path.join(root, 'dist', 'cli-agents');
const wrappers = ['cascade-note', 'cascade-chat', 'cascade-scratchpad'];

fs.mkdirSync(targetDir, { recursive: true });

for (const wrapper of wrappers) {
  const source = path.join(sourceDir, wrapper);
  const target = path.join(targetDir, wrapper);
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
}
