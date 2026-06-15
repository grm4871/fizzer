const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

let db = null;
let configPath = null;
let config = null;

/**
 * Get the application data directory based on platform
 */
function getAppDataPath() {
  const platform = os.platform();

  if (platform === 'win32') {
    // Windows: %APPDATA%/cascade
    return path.join(process.env.APPDATA, 'cascade');
  } else {
    // macOS and Linux: ~/.config/cascade
    return path.join(os.homedir(), '.config', 'cascade');
  }
}

/**
 * Initialize or load the config file
 */
function initConfig() {
  const appDataPath = getAppDataPath();

  // Ensure directory exists
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }

  configPath = path.join(appDataPath, 'config.json');

  // Create default config if it doesn't exist
  if (!fs.existsSync(configPath)) {
    const defaultDbPath = path.join(appDataPath, 'cascade.db');
    config = {
      db_path: defaultDbPath
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log('[Database] Created config file at:', configPath);
  } else {
    // Load existing config
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
    console.log('[Database] Loaded config from:', configPath);
  }

  return config;
}

/**
 * Initialize the database schema
 */
function createSchema(database) {
  // Netdoc table (main content storage)
  database.exec(`
    CREATE TABLE IF NOT EXISTS netdoc (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      can_edit INTEGER NOT NULL DEFAULT 0,
      last_synced TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      protolinks TEXT NOT NULL DEFAULT '',
      neolinks TEXT NOT NULL DEFAULT '',
      vanity_link TEXT UNIQUE,
      style TEXT DEFAULT '',
      html_cache TEXT DEFAULT '',
      netdoc_hash TEXT NOT NULL DEFAULT ''
    );
  `);

  // Add can_edit and last_synced columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE netdoc ADD COLUMN can_edit INTEGER NOT NULL DEFAULT 0;`);
  } catch (e) {
    // Column already exists
  }
  try {
    database.exec(`ALTER TABLE netdoc ADD COLUMN last_synced TEXT;`);
  } catch (e) {
    // Column already exists
  }

  // Netdoc comments (relationships between netdocs)
  database.exec(`
    CREATE TABLE IF NOT EXISTS netdoc_comment (
      id TEXT PRIMARY KEY ,
      parent_netdoc_id TEXT NOT NULL,
      comment_netdoc_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (parent_netdoc_id, comment_netdoc_id),
      FOREIGN KEY (parent_netdoc_id) REFERENCES netdoc(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_netdoc_id) REFERENCES netdoc(id) ON DELETE CASCADE
    );
  `);

  // Netdoc version history
  database.exec(`
    CREATE TABLE IF NOT EXISTS netdoc_version (
      id TEXT PRIMARY KEY,
      netdoc_id TEXT NOT NULL,
      text TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (netdoc_id) REFERENCES netdoc(id) ON DELETE CASCADE
    );
  `);

  // App metadata table
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // User settings table
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const insertMetadata = database.prepare('INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)');
  insertMetadata.run('schema_version', '1');

  console.log('[Database] Schema initialized');
}

/**
 * Initialize the database connection
 */
function initDatabase() {
  if (db) {
    console.log('[Database] Database already initialized');
    return db;
  }

  try {
    // Load config
    const cfg = initConfig();
    const dbPath = cfg.db_path;

    // Ensure database directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database
    db = new Database(dbPath);
    console.log('[Database] Opened database at:', dbPath);

    // Initialize schema
    createSchema(db);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    return db;
  } catch (error) {
    console.error('[Database] Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Close the database connection
 */
function closeDatabase() {
  if (db) {
    try {
      db.close();
      console.log('[Database] Database connection closed');
      db = null;
    } catch (error) {
      console.error('[Database] Error closing database:', error);
      throw error;
    }
  }
}

/**
 * Get the database instance
 */
function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Get a setting from the database
 */
function getSetting(key) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT value FROM user_settings WHERE key = ?');
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * Set a setting in the database
 */
function setSetting(key, value) {
  const database = getDatabase();
  const stmt = database.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

/**
 * Delete a setting from the database
 */
function deleteSetting(key) {
  const database = getDatabase();
  const stmt = database.prepare('DELETE FROM user_settings WHERE key = ?');
  stmt.run(key);
}

// ==================== NETDOC OPERATIONS ====================

/**
 * Check if a netdoc exists in the local database
 */
function netdocExists(id) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT 1 FROM netdoc WHERE id = ?');
  const row = stmt.get(id);
  return !!row;
}

/**
 * Get a netdoc from the local database
 */
function getNetdoc(id) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM netdoc WHERE id = ?');
  return stmt.get(id.toLowerCase()) || null;
}

/**
 * Save or update a netdoc in the local database
 */
function saveNetdoc(id, name, content, canEdit) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO netdoc (id, name, content, can_edit, last_synced, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      content = excluded.content,
      can_edit = excluded.can_edit,
      last_synced = excluded.last_synced,
      updated_at = excluded.updated_at
  `);
  stmt.run(id, name, content, canEdit ? 1 : 0, now, now, now);
  return getNetdoc(id);
}

/**
 * Update only the content of a netdoc (for local edits)
 */
function updateNetdocContent(id, name, content) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    UPDATE netdoc SET name = ?, content = ?, updated_at = ? WHERE id = ?
  `);
  const result = stmt.run(name, content, now, id.toLowerCase());
  return result.changes > 0;
}

/**
 * Delete a netdoc from the local database
 */
function deleteNetdoc(id) {
  const database = getDatabase();
  const stmt = database.prepare('DELETE FROM netdoc WHERE id = ?');
  const result = stmt.run(id.toLowerCase());
  return result.changes > 0;
}

/**
 * Get all versions for a netdoc from local database
 */
function getNetdocVersions(netdocId) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM netdoc_version WHERE netdoc_id = ? ORDER BY created_at DESC');
  return stmt.all(netdocId.toLowerCase());
}

/**
 * Save a new version for a netdoc
 */
function saveNetdocVersion(id, netdocId, content, title, author) {
  const database = getDatabase();
  const now = new Date().toISOString();
  const stmt = database.prepare(`
    INSERT INTO netdoc_version (id, netdoc_id, content, title, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, netdocId, content, title, author, now);
}

/**
 * Get the latest version content for comparison
 */
function getLatestVersionContent(netdocId) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT content FROM netdoc_version WHERE netdoc_id = ? ORDER BY created_at DESC LIMIT 1');
  const row = stmt.get(netdocId.toLowerCase());
  return row ? row.content : null;
}

/**
 * Update the database path in config.json
 */
function updateDbPath(newPath) {
  if (!configPath) {
    throw new Error('Config not initialized. Call initConfig() first.');
  }

  try {
    config.db_path = newPath;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log('[Database] Updated db_path in config to:', newPath);
    return true;
  } catch (error) {
    console.error('[Database] Failed to update db_path:', error);
    throw error;
  }
}

module.exports = {
  initDatabase,
  closeDatabase,
  getDatabase,
  getSetting,
  setSetting,
  deleteSetting,
  updateDbPath,
  getAppDataPath,
  getConfigPath: () => configPath,
  getConfig: () => config,
  // Netdoc operations
  netdocExists,
  getNetdoc,
  saveNetdoc,
  updateNetdocContent,
  deleteNetdoc,
  getNetdocVersions,
  saveNetdocVersion,
  getLatestVersionContent
};
