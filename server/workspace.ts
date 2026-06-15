import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

type Db = Database.Database;

export type Workspace = {
  id: number;
  name: string;
  repo_path: string;
  specs_dir: string;
  created_by: number;
  created_at: string;
};

export type SpecStatus = 'draft' | 'ready' | 'implementing' | 'implemented' | 'stale';

export type SpecIndexRow = {
  id: string;
  workspace_id: number;
  rel_path: string;
  title: string;
  status: SpecStatus;
  targets_json: string;
  depends_json: string;
  updated_at: string;
};

export type ParsedSpec = {
  frontmatter: Record<string, string | string[]>;
  body: string;
};

const VALID_STATUSES = new Set(['draft', 'ready', 'implementing', 'implemented', 'stale']);

export function ensureWorkspaceSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      specs_dir TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS specs (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      targets_json TEXT NOT NULL DEFAULT '[]',
      depends_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, rel_path)
    );
  `);
}

export function parseSpec(content: string): ParsedSpec {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: content };

  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const frontmatter: ParsedSpec['frontmatter'] = {};

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    frontmatter[key] = parseFrontmatterValue(value);
  }

  return { frontmatter, body };
}

export function serializeSpec(frontmatter: Record<string, string | string[]>, body: string) {
  const lines = Object.entries(frontmatter).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.join(', ')}]`;
    return `${key}: ${value}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body.replace(/^\r?\n/, '')}`;
}

export function setSpecContentStatus(content: string, status: SpecStatus) {
  const parsed = parseSpec(content);
  return serializeSpec({ ...parsed.frontmatter, status }, parsed.body);
}

export function getSpecTitle(content: string) {
  const { frontmatter, body } = parseSpec(content);
  const title = stringValue(frontmatter.title);
  if (title) return title;
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || 'Untitled spec';
}

export function getSpecId(relPath: string, content: string) {
  const parsed = parseSpec(content);
  const frontmatterId = stringValue(parsed.frontmatter.id);
  return slugify(frontmatterId || relPath.replace(/\.md$/i, ''));
}

export function getSpecStatus(content: string): SpecStatus {
  const status = stringValue(parseSpec(content).frontmatter.status) || 'draft';
  return VALID_STATUSES.has(status) ? status as SpecStatus : 'draft';
}

export function getSpecLists(content: string) {
  const { frontmatter } = parseSpec(content);
  return {
    targets: arrayValue(frontmatter.targets),
    depends: arrayValue(frontmatter.depends),
  };
}

export function normalizeWorkspaceInput(input: { name?: unknown; repo_path?: unknown; specs_dir?: unknown }, fallbackName = 'Workspace') {
  const repoPath = path.resolve(String(input.repo_path || process.cwd()));
  const specsDir = path.resolve(String(input.specs_dir || path.join(repoPath, 'specs')));
  if (!isInsideOrSame(repoPath, specsDir)) {
    throw new Error('Specs directory must be inside the workspace repo');
  }
  return {
    name: String(input.name || path.basename(repoPath) || fallbackName).trim() || fallbackName,
    repoPath,
    specsDir,
  };
}

export function listWorkspaces(db: Db, userId: number) {
  return db.prepare('SELECT * FROM workspaces WHERE created_by = ? ORDER BY created_at DESC').all(userId) as Workspace[];
}

export function listAllWorkspaces(db: Db) {
  return db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as Workspace[];
}

export function getWorkspace(db: Db, id: number, userId: number) {
  return db.prepare('SELECT * FROM workspaces WHERE id = ? AND created_by = ?').get(id, userId) as Workspace | undefined;
}

export function createWorkspace(db: Db, userId: number, input: { name?: unknown; repo_path?: unknown; specs_dir?: unknown }) {
  const normalized = normalizeWorkspaceInput(input);
  fs.mkdirSync(normalized.specsDir, { recursive: true });
  const result = db.prepare(
    'INSERT INTO workspaces (name, repo_path, specs_dir, created_by) VALUES (?, ?, ?, ?)'
  ).run(normalized.name, normalized.repoPath, normalized.specsDir, userId);
  const workspace = getWorkspace(db, Number(result.lastInsertRowid), userId)!;
  scanWorkspace(db, workspace);
  return workspace;
}

export function scanWorkspace(db: Db, workspace: Workspace) {
  fs.mkdirSync(workspace.specs_dir, { recursive: true });
  const files = listMarkdownFiles(workspace.specs_dir);
  const seen = new Set<string>();

  const upsert = db.prepare(`
    INSERT INTO specs (id, workspace_id, rel_path, title, status, targets_json, depends_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      rel_path = excluded.rel_path,
      title = excluded.title,
      status = excluded.status,
      targets_json = excluded.targets_json,
      depends_json = excluded.depends_json,
      updated_at = CURRENT_TIMESTAMP
  `);
  const removeMissing = files.length > 0
    ? db.prepare('DELETE FROM specs WHERE workspace_id = ? AND rel_path NOT IN (' + files.map(() => '?').join(',') + ')')
    : null;
  const removeAll = db.prepare('DELETE FROM specs WHERE workspace_id = ?');

  const tx = db.transaction((paths: string[]) => {
    for (const filePath of paths) {
      const content = fs.readFileSync(filePath, 'utf8');
      const relPath = path.relative(workspace.specs_dir, filePath).split(path.sep).join('/');
      const id = getSpecId(relPath, content);
      const lists = getSpecLists(content);
      seen.add(relPath);
      upsert.run(
        id,
        workspace.id,
        relPath,
        getSpecTitle(content),
        getSpecStatus(content),
        JSON.stringify(lists.targets),
        JSON.stringify(lists.depends),
      );
    }
    if (paths.length > 0) removeMissing?.run(workspace.id, ...Array.from(seen));
    else removeAll.run(workspace.id);
  });

  tx(files);
  return listSpecs(db, workspace.id);
}

export function listSpecs(db: Db, workspaceId: number) {
  refreshStaleStatuses(db, workspaceId);
  const rows = db.prepare('SELECT * FROM specs WHERE workspace_id = ? ORDER BY rel_path ASC').all(workspaceId) as SpecIndexRow[];
  return rows.map(hydrateSpecRow);
}

export function getSpec(db: Db, id: string) {
  const row = db.prepare('SELECT * FROM specs WHERE id = ?').get(id) as SpecIndexRow | undefined;
  return row ? hydrateSpecRow(row) : undefined;
}

export function readSpecFile(db: Db, id: string) {
  const spec = getSpec(db, id);
  if (!spec) return undefined;
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(spec.workspace_id) as Workspace | undefined;
  if (!workspace) return undefined;
  const filePath = safeSpecPath(workspace.specs_dir, spec.rel_path);
  const content = fs.readFileSync(filePath, 'utf8');
  return { ...spec, content, file_path: filePath };
}

export function writeSpecFile(db: Db, id: string, content: string) {
  const existing = getSpec(db, id);
  if (!existing) return undefined;
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(existing.workspace_id) as Workspace | undefined;
  if (!workspace) return undefined;

  const filePath = safeSpecPath(workspace.specs_dir, existing.rel_path);
  fs.writeFileSync(filePath, content, 'utf8');
  const lists = getSpecLists(content);
  db.prepare(`
    UPDATE specs
    SET title = ?, status = ?, targets_json = ?, depends_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(getSpecTitle(content), getSpecStatus(content), JSON.stringify(lists.targets), JSON.stringify(lists.depends), id);
  return readSpecFile(db, id);
}

export function createSpecFile(db: Db, workspace: Workspace, input: { rel_path?: unknown; title?: unknown; status?: unknown }) {
  const relPath = normalizeRelPath(String(input.rel_path || `${slugify(String(input.title || 'untitled-spec'))}.md`));
  const filePath = safeSpecPath(workspace.specs_dir, relPath);
  if (fs.existsSync(filePath)) throw new Error('Spec file already exists');

  const title = String(input.title || 'Untitled Spec').trim() || 'Untitled Spec';
  const status = VALID_STATUSES.has(String(input.status)) ? String(input.status) : 'draft';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serializeSpec({ id: slugify(relPath.replace(/\.md$/i, '')), status }, `# ${title}\n\n`), 'utf8');
  scanWorkspace(db, workspace);
  return readSpecFile(db, getSpecId(relPath, fs.readFileSync(filePath, 'utf8')));
}

export function watchWorkspace(db: Db, workspace: Workspace, onChange?: (workspace: Workspace) => void) {
  fs.mkdirSync(workspace.specs_dir, { recursive: true });
  const watchers: fs.FSWatcher[] = [];
  let timer: NodeJS.Timeout | null = null;

  const scheduleScan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      scanWorkspace(db, workspace);
      onChange?.(workspace);
    }, 250);
  };

  const watchDir = (dir: string) => {
    try {
      watchers.push(fs.watch(dir, (_event, filename) => {
        if (!filename || String(filename).endsWith('.md')) scheduleScan();
      }));
    } catch {
      // The directory may have disappeared between scan and watch setup.
    }
  };

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    watchDir(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };

  walk(workspace.specs_dir);

  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

function hydrateSpecRow(row: SpecIndexRow) {
  return {
    ...row,
    targets: safeJsonArray(row.targets_json),
    depends: safeJsonArray(row.depends_json),
  };
}

function refreshStaleStatuses(db: Db, workspaceId: number) {
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as Workspace | undefined;
  if (!workspace) return;
  const rows = db.prepare("SELECT * FROM specs WHERE workspace_id = ? AND status = 'implemented'").all(workspaceId) as SpecIndexRow[];
  const update = db.prepare("UPDATE specs SET status = 'stale', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const row of rows) {
    const targets = safeJsonArray(row.targets_json);
    if (targets.length === 0) continue;
    const merged = db.prepare(`
      SELECT finished_at
      FROM runs
      WHERE spec_id = ? AND status = 'merged'
      ORDER BY finished_at DESC, id DESC
      LIMIT 1
    `).get(row.id) as { finished_at: string } | undefined;
    if (!merged?.finished_at) continue;
    const mergedAt = new Date(`${merged.finished_at}Z`).getTime();
    const isStale = targets.some((target) => {
      const targetPath = path.resolve(workspace.repo_path, target);
      if (!isInsideOrSame(workspace.repo_path, targetPath) || !fs.existsSync(targetPath)) return false;
      return fs.statSync(targetPath).mtimeMs > mergedAt;
    });
    if (isStale) update.run(row.id);
  }
}

function listMarkdownFiles(root: string) {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(fullPath);
    }
  };
  walk(root);
  return found.sort();
}

function parseFrontmatterValue(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function stringValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function arrayValue(value: string | string[] | undefined) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function safeJsonArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRelPath(relPath: string) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.toLowerCase().endsWith('.md') ? normalized : `${normalized}.md`;
}

function safeSpecPath(specsDir: string, relPath: string) {
  const fullPath = path.resolve(specsDir, relPath);
  if (!isInsideOrSame(specsDir, fullPath)) throw new Error('Invalid spec path');
  return fullPath;
}

function isInsideOrSame(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/[/_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled-spec';
}
