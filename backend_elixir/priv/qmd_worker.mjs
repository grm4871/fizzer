import path from 'node:path';
import { pathToFileURL } from 'node:url';

const nodeRoot = process.env.CASCADE_NODE_ROOT || path.resolve(import.meta.dirname, '../..');
const packageUrl = pathToFileURL(path.join(nodeRoot, 'package.json')).href;
const qmdEntry = import.meta.resolve('@tobilu/qmd', packageUrl);
const { createStore } = await import(qmdEntry);

const indexes = new Map();
let input = Buffer.alloc(0);

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function openIndex(indexKey, root) {
  const existing = indexes.get(indexKey);
  if (existing) return existing;
  const store = await createStore({
    dbPath: path.join(root, 'index.sqlite'),
    config: {
      collections: {
        notes: { path: path.join(root, 'notes'), pattern: '**/*.md' },
        chats: { path: path.join(root, 'chats'), pattern: '**/*.md' },
      },
    },
  });
  const index = { store, fingerprint: '', syncing: undefined, embedding: undefined };
  indexes.set(indexKey, index);
  return index;
}

async function rankedPaths(index, query, scope, limit) {
  const collections = scope === 'all' ? undefined : [scope === 'notes' ? 'notes' : 'chats'];
  const lexical = collections
    ? (await Promise.all(collections.map((collection) => index.store.searchLex(query, { collection, limit })))).flat()
    : await index.store.searchLex(query, { limit });

  const status = await index.store.getStatus();
  const vector = status.hasVectorIndex
    ? (collections
      ? (await Promise.all(collections.map((collection) => index.store.searchVector(query, { collection, limit })))).flat()
      : await index.store.searchVector(query, { limit }))
    : [];

  const resolve = (result) => {
    const resolved = index.store.internal.resolveVirtualPath(result.filepath);
    return resolved ? path.resolve(resolved) : null;
  };

  return {
    lexical: lexical.map(resolve).filter(Boolean),
    vector: vector.map(resolve).filter(Boolean),
  };
}

async function search(message) {
  const index = await openIndex(message.indexKey, message.root);

  while (index.fingerprint !== message.fingerprint) {
    if (!index.syncing) {
      const target = message.fingerprint;
      index.syncing = index.store.update()
        .then(() => { index.fingerprint = target; })
        .finally(() => { index.syncing = undefined; });
    }
    await index.syncing;
  }

  if (process.env.CASCADE_QMD_SEMANTIC !== 'false' && !index.embedding && (await index.store.getStatus()).needsEmbedding > 0) {
    index.embedding = index.store.embed({ chunkStrategy: 'regex' })
      .catch(() => undefined)
      .finally(() => { index.embedding = undefined; });
  }

  return rankedPaths(index, message.query, message.scope, message.limit);
}

async function handle(message) {
  if (message.op === 'clear') {
    indexes.clear();
    return { id: message.id, ok: true, lexical: [], vector: [] };
  }
  if (message.op !== 'search') throw new Error(`unsupported operation: ${message.op}`);
  const result = await search(message);
  return { id: message.id, ok: true, ...result };
}

async function drain() {
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const body = input.subarray(4, length + 4);
    input = input.subarray(length + 4);
    let message;
    try {
      message = JSON.parse(body.toString('utf8'));
      send(await handle(message));
    } catch (error) {
      send({ id: message?.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  drain().catch(() => {
    process.exitCode = 1;
  });
});
