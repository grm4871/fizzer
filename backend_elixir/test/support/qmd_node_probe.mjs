import Database from 'better-sqlite3';

const [databasePath, qmdRoot, vaultId, query, scope = 'all', limitRaw = '40'] = process.argv.slice(2);
if (!databasePath || !qmdRoot || !vaultId || !query) {
  throw new Error('usage: qmd_node_probe DB ROOT VAULT QUERY [SCOPE] [LIMIT]');
}
process.env.CASCADE_QMD_DIR = qmdRoot;
process.env.CASCADE_QMD_SEMANTIC = 'false';

const { searchWithQmd } = await import('../../../dist/server/qmd-search.js');
const db = new Database(databasePath, { readonly: true });
try {
  const hits = await searchWithQmd(db, vaultId, query, { scope, limit: Number(limitRaw) });
  process.stdout.write(JSON.stringify(hits));
} finally {
  db.close();
}
