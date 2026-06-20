/**
 * @file database.cjs — SQLite database module for Cascade
 *
 * Manages a local SQLite database (via better-sqlite3) that stores application
 * settings and netdoc documents. Handles config file management (config.json),
 * database initialization, schema creation / migration, user settings CRUD,
 * and full netdoc + version-history persistence.
 *
 * The database path is configurable via `config.json` which lives in the
 * platform-specific app-data directory (~/.config/cascade on Linux/macOS,
 * %APPDATA%/cascade on Windows).
 *
 * @module cascade-electron/database
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const os = require('os');

let db = null;
let configPath = null;
let config = null;

// ═══════════════════════════════════════════════════════════════
// CONFIG MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Returns the platform-specific application data directory.
 *  - Windows: `%APPDATA%/cascade`
 *  - macOS / Linux: `~/.config/cascade`
 *
 * @returns {string} Absolute path to the app data directory.
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
 * Initializes or loads the config file (`config.json`).
 * Creates the app-data directory and a default config (with `db_path`)
 * if they do not already exist.
 *
 * @returns {{ db_path: string }} The parsed config object.
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
 * Updates the database file path stored in `config.json` and persists
 * the change to disk. Does not reopen the database connection — the
 * caller is responsible for restarting the app if a path change is needed.
 *
 * @param {string} newPath - The new absolute path for the SQLite file.
 * @returns {boolean} `true` on success.
 * @throws {Error} If config has not been initialized or the write fails.
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

// ═══════════════════════════════════════════════════════════════
// DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════

/**
 * Opens (or returns the existing) database connection, creates the
 * schema if needed, and enables WAL journal mode.
 *
 * @returns {import('better-sqlite3').Database} The live database instance.
 * @throws {Error} If the database file cannot be opened or schema fails.
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
 * Closes the active database connection and resets the module-level
 * reference. Safe to call even if no connection is open.
 */
function closeDatabase() {
  if (db) {
    try {
      db.close();
      db = null;
    } catch (_) {
      db = null;
    }
  }
}

/**
 * Returns the live database instance, throwing if it has not yet been
 * initialized via {@link initDatabase}.
 *
 * @returns {import('better-sqlite3').Database}
 * @throws {Error} If the database has not been initialized.
 */
function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// ═══════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════

/**
 * Creates all required tables if they do not already exist and runs
 * lightweight ALTER TABLE migrations for columns added after v1.
 *
 * @param {import('better-sqlite3').Database} database
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

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════

/**
 * Retrieves a single user setting by key.
 *
 * @param {string} key - The setting key.
 * @returns {string | null} The setting value, or `null` if not found.
 */
function getSetting(key) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT value FROM user_settings WHERE key = ?');
  const row = stmt.get(key);
  return row ? row.value : null;
}

/**
 * Inserts or replaces a user setting.
 *
 * @param {string} key   - The setting key.
 * @param {string} value - The setting value.
 */
function setSetting(key, value) {
  const database = getDatabase();
  const stmt = database.prepare('INSERT OR REPLACE INTO user_settings (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

/**
 * Deletes a user setting by key.
 *
 * @param {string} key - The setting key to remove.
 */
function deleteSetting(key) {
  const database = getDatabase();
  const stmt = database.prepare('DELETE FROM user_settings WHERE key = ?');
  stmt.run(key);
}

// ═══════════════════════════════════════════════════════════════
// NETDOC CRUD
// ═══════════════════════════════════════════════════════════════

/**
 * Checks whether a netdoc with the given ID exists in the local database.
 *
 * @param {string} id - The netdoc ID.
 * @returns {boolean}
 */
function netdocExists(id) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT 1 FROM netdoc WHERE id = ?');
  const row = stmt.get(id);
  return !!row;
}

/**
 * Retrieves a full netdoc row by ID (case-insensitive lookup).
 *
 * @param {string} id - The netdoc ID.
 * @returns {object | null} The netdoc row, or `null` if not found.
 */
function getNetdoc(id) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM netdoc WHERE id = ?');
  return stmt.get(id.toLowerCase()) || null;
}

/**
 * Inserts a new netdoc or upserts an existing one (matched by `id`).
 * On conflict the name, text, can_edit, last_synced, and updated_at
 * columns are overwritten.
 *
 * @param {string}  id      - Unique netdoc identifier.
 * @param {string}  name    - Human-readable title.
 * @param {string}  content - The document text body.
 * @param {boolean} canEdit - Whether the current user may edit the doc.
 * @returns {object} The saved netdoc row (re-fetched after upsert).
 */
function saveNetdoc(id, name, content, canEdit) {
  const database = getDatabase();
  const now = new Date().toISOString();
  // Fixed: column is 'text' not 'content' per schema
  const stmt = database.prepare(`
    INSERT INTO netdoc (id, name, text, can_edit, last_synced, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      text = excluded.text,
      can_edit = excluded.can_edit,
      last_synced = excluded.last_synced,
      updated_at = excluded.updated_at
  `);
  stmt.run(id, name, content, canEdit ? 1 : 0, now, now, now);
  return getNetdoc(id);
}

/**
 * Updates only the name and text content of an existing netdoc (for local
 * edits). Sets `updated_at` to the current timestamp.
 *
 * @param {string} id      - Netdoc ID (matched case-insensitively).
 * @param {string} name    - Updated title.
 * @param {string} content - Updated document body.
 * @returns {boolean} `true` if a row was actually modified.
 */
function updateNetdocContent(id, name, content) {
  const database = getDatabase();
  const now = new Date().toISOString();
  // Fixed: column is 'text' not 'content' per schema
  const stmt = database.prepare(`
    UPDATE netdoc SET name = ?, text = ?, updated_at = ? WHERE id = ?
  `);
  const result = stmt.run(name, content, now, id.toLowerCase());
  return result.changes > 0;
}

/**
 * Permanently deletes a netdoc by ID. Foreign-key cascades will also
 * remove associated comments and versions.
 *
 * @param {string} id - Netdoc ID (matched case-insensitively).
 * @returns {boolean} `true` if a row was actually deleted.
 */
function deleteNetdoc(id) {
  const database = getDatabase();
  const stmt = database.prepare('DELETE FROM netdoc WHERE id = ?');
  const result = stmt.run(id.toLowerCase());
  return result.changes > 0;
}

// ═══════════════════════════════════════════════════════════════
// NETDOC VERSIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Returns all saved versions for a netdoc, ordered newest-first.
 *
 * @param {string} netdocId - The parent netdoc ID.
 * @returns {object[]} Array of version rows.
 */
function getNetdocVersions(netdocId) {
  const database = getDatabase();
  const stmt = database.prepare('SELECT * FROM netdoc_version WHERE netdoc_id = ? ORDER BY created_at DESC');
  return stmt.all(netdocId.toLowerCase());
}

/**
 * Saves a new version snapshot for a netdoc.
 *
 * @param {string} id       - Unique version identifier.
 * @param {string} netdocId - The parent netdoc ID.
 * @param {string} content  - The full document text at this point in time.
 * @param {string} title    - Version title / label.
 * @param {string} author   - Author who created the version.
 */
function saveNetdocVersion(id, netdocId, content, title, author) {
  const database = getDatabase();
  const now = new Date().toISOString();
  // Fixed: column is 'text' not 'content' per schema
  const stmt = database.prepare(`
    INSERT INTO netdoc_version (id, netdoc_id, text, title, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, netdocId, content, title, author, now);
}

/**
 * Returns the text body of the most recent version for a netdoc,
 * useful for diffing against the current working copy. Returns `null`
 * if no versions exist.
 *
 * @param {string} netdocId - The parent netdoc ID.
 * @returns {string | null} The latest version's text content.
 */
function getLatestVersionContent(netdocId) {
  const database = getDatabase();
  // Fixed: column is 'text' not 'content' per schema
  const stmt = database.prepare('SELECT text FROM netdoc_version WHERE netdoc_id = ? ORDER BY created_at DESC LIMIT 1');
  const row = stmt.get(netdocId.toLowerCase());
  return row ? row.text : null;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
  // Database lifecycle
  initDatabase,
  closeDatabase,
  getDatabase,
  // Settings
  getSetting,
  setSetting,
  deleteSetting,
  // Config
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
