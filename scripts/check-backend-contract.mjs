#!/usr/bin/env node

/**
 * Generate or check the source-derived, static backend contract manifest.
 *
 * This deliberately records declarations, not inferred runtime responses. The
 * differential HTTP/Socket.IO suite is responsible for status codes, headers,
 * response payloads, ordering, and wire-level behavior.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_MANIFEST = path.join(SCRIPT_DIR, 'backend-contract.v1.json');
const HTTP_METHODS = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
const SOCKET_HELPER_EVENT_ARGUMENTS = new Map([
  ['emitVaultEvent', 1],
  ['emitChatMessageEvent', 2],
  ['emitChatAgentEvent', 2],
]);

function relativeSource(filePath) {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function listProductionSources() {
  const sources = [path.join(REPO_ROOT, 'index.ts')];
  const serverDir = path.join(REPO_ROOT, 'server');
  const pending = [serverDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
        sources.push(entryPath);
      }
    }
  }
  return sources.sort((left, right) => relativeSource(left).localeCompare(relativeSource(right)));
}

function sourceLine(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function stringValue(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function compactExpression(node, sourceFile) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return '<inline>';
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(sourceFile).replace(/\s+/g, ' ');
    return `${callee}(...)`;
  }
  return node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 160);
}

function routePaths(node) {
  const direct = stringValue(node);
  if (direct !== null) return [direct];
  if (!ts.isArrayLiteralExpression(node)) return [];
  const aliases = [];
  for (const element of node.elements) {
    const alias = stringValue(element);
    if (alias !== null) aliases.push(alias);
  }
  return aliases;
}

function namespaceDeclarations(sourceFile) {
  const namespaces = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isPropertyAccessExpression(node.initializer.expression)
      && node.initializer.expression.name.text === 'of') {
      const namespace = stringValue(node.initializer.arguments[0]);
      if (namespace !== null) namespaces.set(node.name.text, namespace);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return namespaces;
}

function namespaceForNode(node, sourceFile, declarations) {
  for (let current = node; current; current = current.parent) {
    if (!ts.isCallExpression(current)
      || !ts.isPropertyAccessExpression(current.expression)
      || current.expression.name.text !== 'on'
      || stringValue(current.arguments[0]) !== 'connection') continue;
    const receiver = current.expression.expression.getText(sourceFile);
    if (declarations.has(receiver)) return declarations.get(receiver);
  }

  const callText = node.getText(sourceFile);
  for (const [identifier, namespace] of declarations) {
    if (callText.includes(identifier)) return namespace;
  }

  const source = relativeSource(sourceFile.fileName);
  if (source === 'server/desktop-runner.ts') return '/runners';
  return '<unknown>';
}

function extractTypeScriptSurface(sourceFile) {
  const routes = [];
  const inbound = [];
  const outbound = [];
  const namespaces = namespaceDeclarations(sourceFile);

  function recordInbound(node, event) {
    inbound.push({
      namespace: namespaceForNode(node, sourceFile, namespaces),
      event,
      source: relativeSource(sourceFile.fileName),
      line: sourceLine(sourceFile, node.getStart(sourceFile)),
    });
  }

  function recordOutbound(node, event, namespace = namespaceForNode(node, sourceFile, namespaces)) {
    outbound.push({
      namespace,
      event,
      source: relativeSource(sourceFile.fileName),
      line: sourceLine(sourceFile, node.getStart(sourceFile)),
    });
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const member = node.expression.name.text;
      const receiver = node.expression.expression.getText(sourceFile);

      if (HTTP_METHODS.has(member) && receiver === 'app') {
        const paths = node.arguments.length > 0 ? routePaths(node.arguments[0]) : [];
        const chain = node.arguments.slice(1).map((argument) => compactExpression(argument, sourceFile));
        for (const routePath of paths) {
          routes.push({
            method: member.toUpperCase(),
            path: routePath,
            handlers: chain,
            source: relativeSource(sourceFile.fileName),
            line: sourceLine(sourceFile, node.getStart(sourceFile)),
          });
        }
      }

      if ((member === 'on' || member === 'once') && node.arguments.length > 0) {
        const event = stringValue(node.arguments[0]);
        const receiverIsSocket = receiver === 'socket';
        const receiverIsNamespace = namespaces.has(receiver);
        if (event !== null && (receiverIsSocket || receiverIsNamespace)) recordInbound(node, event);
      }

      if (member === 'emit' && node.arguments.length > 0) {
        const event = stringValue(node.arguments[0]);
        if (event !== null) recordOutbound(node, event);
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const eventArgument = SOCKET_HELPER_EVENT_ARGUMENTS.get(node.expression.text);
      if (eventArgument !== undefined) {
        const event = stringValue(node.arguments[eventArgument]);
        if (event !== null) recordOutbound(node, event, '/vault');
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { routes, inbound, outbound };
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
  return /[`'"]$/.test(text) ? text.length - 1 : text.length;
}

function extractSqlDeclarations(sourceFile) {
  const declarations = [];
  const declarationStart = /\bCREATE\s+(UNIQUE\s+)?(VIRTUAL\s+)?(TABLE|INDEX|TRIGGER)\s+(IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/gi;

  function dynamicNameValues(node, rawName) {
    const placeholder = /^\$\{([A-Za-z_$][\w$]*)\}$/.exec(rawName);
    if (!placeholder) return undefined;
    let owner = node.parent;
    while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
    if (!owner?.name) return undefined;
    const parameterIndex = owner.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === placeholder[1],
    );
    if (parameterIndex < 0) return undefined;

    const values = new Set();
    function visitCalls(candidate) {
      if (ts.isCallExpression(candidate)
        && ts.isIdentifier(candidate.expression)
        && candidate.expression.text === owner.name.text) {
        const value = stringValue(candidate.arguments[parameterIndex]);
        if (value !== null) values.add(value);
      }
      ts.forEachChild(candidate, visitCalls);
    }
    visitCalls(sourceFile);
    return values.size > 0 ? [...values].sort() : undefined;
  }

  function inspectLiteral(node) {
    const raw = node.getText(sourceFile);
    declarationStart.lastIndex = 0;
    for (let match = declarationStart.exec(raw); match; match = declarationStart.exec(raw)) {
      const kind = match[3].toLowerCase();
      const end = endOfSqlDeclaration(raw, match.index, kind);
      const name = match[5].replace(/^[`'"\[]|[`'"\]]$/g, '');
      const declaration = {
        kind,
        name,
        unique: Boolean(match[1]),
        virtual: Boolean(match[2]),
        ifNotExists: Boolean(match[4]),
        sql: normalizeSql(raw.slice(match.index, end)),
        source: relativeSource(sourceFile.fileName),
        line: sourceLine(sourceFile, node.getStart(sourceFile) + match.index),
      };
      const resolvedNames = dynamicNameValues(node, name);
      if (resolvedNames) declaration.resolvedNames = resolvedNames;
      declarations.push(declaration);
      declarationStart.lastIndex = Math.max(declarationStart.lastIndex, end);
    }
  }

  function visit(node) {
    if (ts.isTemplateExpression(node)) {
      inspectLiteral(node);
      return;
    }
    if (ts.isStringLiteralLike(node)) inspectLiteral(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return declarations;
}

function compareLocation(left, right) {
  return left.source.localeCompare(right.source)
    || left.line - right.line
    || JSON.stringify(left).localeCompare(JSON.stringify(right));
}

export function buildBackendContractManifest() {
  const sourcePaths = listProductionSources();
  const httpRoutes = [];
  const inbound = [];
  const outbound = [];
  const sqliteDeclarations = [];

  for (const sourcePath of sourcePaths) {
    const text = fs.readFileSync(sourcePath, 'utf8');
    const sourceFile = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const surface = extractTypeScriptSurface(sourceFile);
    httpRoutes.push(...surface.routes);
    inbound.push(...surface.inbound);
    outbound.push(...surface.outbound);
    sqliteDeclarations.push(...extractSqlDeclarations(sourceFile));
  }

  httpRoutes.sort(compareLocation);
  inbound.sort(compareLocation);
  outbound.sort(compareLocation);
  sqliteDeclarations.sort(compareLocation);

  const unknownSocketNamespaces = [...inbound, ...outbound].filter((entry) => entry.namespace === '<unknown>');
  if (unknownSocketNamespaces.length > 0) {
    const locations = unknownSocketNamespaces.map((entry) => `${entry.source}:${entry.line} ${entry.event}`).join(', ');
    throw new Error(`Could not infer Socket.IO namespace for: ${locations}`);
  }

  return {
    manifestVersion: 1,
    generator: 'scripts/check-backend-contract.mjs',
    scope: {
      sources: sourcePaths.map(relativeSource),
      excludes: ['**/*.test.ts', '**/*.d.ts', 'client/**'],
      note: 'Static declarations only; runtime status, headers, bodies, ordering, Engine.IO frames, and ACK payloads require differential tests.',
    },
    summary: {
      httpRoutes: httpRoutes.length,
      socketIoInboundDeclarations: inbound.length,
      socketIoOutboundLiteralDeclarations: outbound.length,
      sqliteDeclarations: sqliteDeclarations.length,
    },
    httpRoutes,
    socketIo: { inbound, outbound },
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
