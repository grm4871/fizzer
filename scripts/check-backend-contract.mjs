#!/usr/bin/env node

/**
 * Generate or check the source-derived, static backend contract manifest.
 *
 * The production backend is Elixir. This records declarations from
 * backend_elixir/lib, not inferred runtime responses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractElixirRoutes } from './check-elixir-route-parity.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ELIXIR_LIB = path.join(REPO_ROOT, 'backend_elixir/lib');
const ELIXIR_WEB = path.join(ELIXIR_LIB, 'cascade_web');
const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, 'backend-contract.v1.json');

function relativeSource(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function walk(directory, suffix = '.ex') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(absolute);
  }
  return files.sort();
}

function sourceLine(text, index) {
  return text.slice(0, index).split('\n').length;
}

function normalizeSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim();
}

function endOfSqlDeclaration(text, start, kind) {
  if (kind === 'trigger') {
    const match = /\bEND\s*;/gi;
    match.lastIndex = start;
    const end = match.exec(text);
    if (end) return end.index + end[0].length;
  }

  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote && text[index + 1] === quote) {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === ';' && depth === 0) return index + 1;
  }
  return text.length;
}

function extractSqlDeclarations(sourcePath, text) {
  const declarations = [];
  const declarationStart = /\bCREATE\s+(UNIQUE\s+)?(VIRTUAL\s+)?(TABLE|INDEX|TRIGGER)\s+(IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/gi;
  for (let match = declarationStart.exec(text); match; match = declarationStart.exec(text)) {
    const kind = match[3].toLowerCase();
    const end = endOfSqlDeclaration(text, match.index, kind);
    declarations.push({
      kind,
      name: match[5].replace(/^[`'"]|[`'"]$/g, ''),
      unique: Boolean(match[1]),
      virtual: Boolean(match[2]),
      ifNotExists: Boolean(match[4]),
      sql: normalizeSql(text.slice(match.index, end)),
      source: relativeSource(sourcePath),
      line: sourceLine(text, match.index),
    });
    declarationStart.lastIndex = Math.max(declarationStart.lastIndex, end);
  }
  return declarations;
}

function extractSocketSurface(sourcePath, text) {
  const inbound = [];
  const outbound = [];
  const source = relativeSource(sourcePath);

  for (const match of text.matchAll(/def handle_event\("([^"]+)",\s*"([^"]+)"/g)) {
    inbound.push({
      namespace: match[1],
      event: match[2],
      source,
      line: sourceLine(text, match.index),
    });
  }
  for (const match of text.matchAll(/def namespace_connected\("([^"]+)"/g)) {
    inbound.push({
      namespace: match[1],
      event: 'connection',
      source,
      line: sourceLine(text, match.index),
    });
  }
  for (const match of text.matchAll(/def namespace_disconnected\("([^"]+)"/g)) {
    inbound.push({
      namespace: match[1],
      event: 'disconnect',
      source,
      line: sourceLine(text, match.index),
    });
  }

  const outboundPatterns = [
    /Hub\.broadcast\([^,]+,\s*(?:@vault_namespace|"(\/[^"]+)")\s*,\s*(?:"([^"]+)"|@([A-Za-z0-9_]+))/g,
    /\{:emit,\s*"([^"]+)"/g,
    /broadcast\("run:[^"]+",\s*"(\/[^"]+)",\s*"([^"]+)"/g,
  ];
  for (const pattern of outboundPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[0].startsWith('{:emit')) {
        outbound.push({
          namespace: '/vault',
          event: match[1],
          source,
          line: sourceLine(text, match.index),
        });
      } else if (match[0].startsWith('broadcast("run:')) {
        outbound.push({
          namespace: match[1],
          event: match[2],
          source,
          line: sourceLine(text, match.index),
        });
      } else {
        outbound.push({
          namespace: match[1] || '/vault',
          event: match[2] || match[3],
          source,
          line: sourceLine(text, match.index),
        });
      }
    }
  }

  for (const match of text.matchAll(/@(?:chat_[a-z_]+|[a-z_]+)\s+"((?:vault|community|runner):[^"]+)"/g)) {
    outbound.push({
      namespace: '/vault',
      event: match[1],
      source,
      line: sourceLine(text, match.index),
    });
  }
  for (const match of text.matchAll(/"((?:vault|community|runner):[A-Za-z0-9:]+)"/g)) {
    outbound.push({
      namespace: match[1].startsWith('runner:') ? '/runners' : '/vault',
      event: match[1],
      source,
      line: sourceLine(text, match.index),
    });
  }

  return { inbound, outbound };
}

function compareLocation(left, right) {
  return left.source.localeCompare(right.source)
    || left.line - right.line
    || JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

export function buildBackendContractManifest() {
  const webSources = walk(ELIXIR_WEB);
  const libSources = walk(ELIXIR_LIB);
  const httpRoutes = extractElixirRoutes(ELIXIR_WEB)
    .map((route) => ({
      method: route.method,
      path: route.path,
      source: path.posix.join('backend_elixir/lib/cascade_web', route.source.split(path.sep).join('/')),
      line: route.line,
    }))
    .sort(compareLocation);

  const inbound = [];
  const outbound = [];
  const sqliteDeclarations = [];

  for (const sourcePath of libSources) {
    const text = fs.readFileSync(sourcePath, 'utf8');
    const sockets = extractSocketSurface(sourcePath, text);
    inbound.push(...sockets.inbound);
    outbound.push(...sockets.outbound);
    sqliteDeclarations.push(...extractSqlDeclarations(sourcePath, text));
  }

  inbound.sort(compareLocation);
  const uniqueOutbound = uniqueBy(
    outbound.sort(compareLocation),
    (entry) => `${entry.namespace} ${entry.event} ${entry.source}:${entry.line}`,
  );
  sqliteDeclarations.sort(compareLocation);

  return {
    manifestVersion: 1,
    generator: 'scripts/check-backend-contract.mjs',
    scope: {
      sources: [...new Set([...webSources, ...libSources].map(relativeSource))].sort(),
      excludes: ['**/*_test.exs', 'client/**'],
      note: 'Static Elixir declarations only; runtime status, headers, bodies, ordering, Engine.IO frames, and ACK payloads require the Elixir e2e and mix suites.',
    },
    summary: {
      httpRoutes: httpRoutes.length,
      socketIoInboundDeclarations: inbound.length,
      socketIoOutboundLiteralDeclarations: uniqueOutbound.length,
      sqliteDeclarations: sqliteDeclarations.length,
    },
    httpRoutes,
    socketIo: { inbound, outbound: uniqueOutbound },
    sqlite: { declarations: sqliteDeclarations },
  };
}

function manifestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const count = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < count; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] ?? '<end of file>',
        actual: actualLines[index] ?? '<end of file>',
      };
    }
  }
  return null;
}

function parseArguments(argv) {
  let mode = 'check';
  let manifestPath = DEFAULT_MANIFEST;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') mode = 'write';
    else if (argument === '--check') mode = 'check';
    else if (argument === '--manifest') {
      manifestPath = path.resolve(argv[index + 1] || '');
      index += 1;
    } else if (argument === '--help') {
      console.log('Usage: node scripts/check-backend-contract.mjs [--check|--write] [--manifest PATH]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { mode, manifestPath };
}

export function run(argv = process.argv.slice(2)) {
  const { mode, manifestPath } = parseArguments(argv);
  const generated = manifestJson(buildBackendContractManifest());
  if (mode === 'write') {
    fs.writeFileSync(manifestPath, generated);
    console.log(`Wrote ${path.relative(REPO_ROOT, manifestPath)}.`);
    return 0;
  }

  if (!fs.existsSync(manifestPath)) {
    console.error(`Backend contract manifest is missing: ${manifestPath}`);
    console.error('Run with --write after reviewing the intended contract change.');
    return 1;
  }
  const expected = fs.readFileSync(manifestPath, 'utf8');
  if (expected !== generated) {
    const difference = firstDifference(expected, generated);
    console.error(`Backend contract drift detected in ${path.relative(REPO_ROOT, manifestPath)}.`);
    if (difference) {
      console.error(`First difference at manifest line ${difference.line}:`);
      console.error(`- ${difference.expected}`);
      console.error(`+ ${difference.actual}`);
    }
    console.error('Review the source change, then regenerate explicitly with --write.');
    return 1;
  }

  const manifest = JSON.parse(generated);
  console.log(
    `Backend contract matches: ${manifest.summary.httpRoutes} HTTP routes, `
      + `${manifest.summary.socketIoInboundDeclarations} inbound Socket.IO declarations, `
      + `${manifest.summary.socketIoOutboundLiteralDeclarations} outbound Socket.IO literals, `
      + `${manifest.summary.sqliteDeclarations} SQLite declarations.`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
