#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HTTP_MACRO = /^\s*(get|post|put|patch|delete|options|head)\s+"([^"]+)"/gm;
const PARITY_ANNOTATION = /^\s*#\s*parity-route\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\S+)\s*$/gm;

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ex')) files.push(absolute);
  }
  return files.sort();
}

function key(route) {
  const normalizedPath = route.path
    .split('/')
    .map((segment) => segment.replace(/^:[A-Za-z0-9_]+/, ':'))
    .join('/');
  return `${route.method} ${normalizedPath}`;
}

export function extractElixirRoutes(directory) {
  const routes = [];
  for (const filename of walk(directory)) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const match of source.matchAll(HTTP_MACRO)) {
      const before = source.slice(0, match.index);
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        source: path.relative(directory, filename),
        line: before.split('\n').length,
      });
    }
    for (const match of source.matchAll(PARITY_ANNOTATION)) {
      const before = source.slice(0, match.index);
      routes.push({
        method: match[1],
        path: match[2],
        source: path.relative(directory, filename),
        line: before.split('\n').length,
        annotation: true,
      });
    }
  }
  return routes;
}

export function compareRoutes(requiredRoutes, implementedRoutes) {
  const required = new Map(requiredRoutes.map((route) => [key(route), route]));
  const implemented = new Map();
  const duplicates = [];

  for (const route of implementedRoutes) {
    const routeKey = key(route);
    if (implemented.has(routeKey)) duplicates.push(`${route.method} ${route.path}`);
    else implemented.set(routeKey, route);
  }

  return {
    missing: [...required.entries()]
      .filter(([routeKey]) => !implemented.has(routeKey))
      .map(([, route]) => `${route.method} ${route.path}`)
      .sort(),
    unexpected: [...implemented.entries()]
      .filter(([routeKey]) => !required.has(routeKey))
      .map(([, route]) => `${route.method} ${route.path}`)
      .sort(),
    duplicates: [...new Set(duplicates)].sort(),
    requiredCount: required.size,
    implementedCount: implemented.size,
  };
}

export function checkRouteParity({ contractPath, webDirectory }) {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const implemented = extractElixirRoutes(webDirectory);
  const result = compareRoutes(contract.httpRoutes, implemented);
  return {
    ...result,
    ok: result.missing.length === 0 && result.unexpected.length === 0 && result.duplicates.length === 0,
    implemented,
  };
}

function parseArgs(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    contractPath: path.join(root, 'scripts/backend-contract.v1.json'),
    webDirectory: path.join(root, 'backend_elixir/lib/cascade_web'),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${arg} requires a value`);
    index += 1;
    if (arg === '--contract') options.contractPath = path.resolve(value);
    else if (arg === '--web-dir') options.webDirectory = path.resolve(value);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = checkRouteParity(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`Elixir HTTP parity passed: ${result.requiredCount}/${result.requiredCount} routes implemented exactly once.`);
  } else {
    console.error(
      `Elixir HTTP parity failed: ${result.implementedCount}/${result.requiredCount} unique routes implemented.`,
    );
    for (const [label, values] of [
      ['missing', result.missing],
      ['unexpected', result.unexpected],
      ['duplicate', result.duplicates],
    ]) {
      for (const value of values) console.error(`  ${label}: ${value}`);
    }
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) main();
