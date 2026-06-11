# Better-SQLite3 Integration Plan for Electron Build


## Overview
Integrate better-sqlite3 into the netaris Electron application to provide local persistent storage for users when running the packaged desktop app.

## Implementation Steps

### 1. Install Dependencies
**Location**: `netaris-elektron/package.json`

Add the following dependencies:
- `better-sqlite3` - SQLite database driver
- `electron-builder` or `electron-rebuild` - For rebuilding native modules for Electron

Add postinstall script to rebuild native modules for the correct Electron version:
```json
"scripts": {
  "postinstall": "electron-rebuild"
}
```

### 2. Create Database Module
**New file**: `netaris-elektron/database.cjs`

This module will:
- Initialize the SQLite database in the user data directory
- Use the config file for the db location
- Export database operations as functions
- Handle database schema creation/migration
- Provide CRUD operations for local data storage

Database path examples:
- Windows: `%APPDATA%/netaris/netaris.db`
- Linux and macOS: `~/.config/netaris/netaris.db`

also in the appdata path or the .config path, have a file called "config.json"
and it should look like 

```
{db_path: ""}
```

and then whatever it is supposed to be by platform

Key functions to implement:
- `initDatabase()` - Create/open database and initialize schema
- `closeDatabase()` - Properly close database connection
- Database operation functions (to be determined based on use case)

### 3. Update Main Process
**File**: `netaris-elektron/main.cjs`

Modifications:
- Import the database module
- Initialize database in `app.whenReady()` handler
- Close database in `app.on('window-all-closed')` and `app.on('will-quit')`
- Set up IPC handlers for database operations

IPC handlers pattern:
```javascript
ipcMain.handle('db:operation', async (event, args) => {
  // Call database module function
  // Return result to renderer
})
```

### 4. Enable IPC Communication
**File**: `netaris-elektron/main.cjs`

Update BrowserWindow webPreferences to enable IPC:
- Keep `contextIsolation: true` (security)
- Keep `nodeIntegration: false` (security)
- Add preload script for safe IPC exposure

**New file**: `netaris-elektron/preload.cjs`

Create preload script that:
- Exposes safe database APIs to renderer via `contextBridge`
- Sanitizes inputs/outputs
- Provides TypeScript-friendly API surface

### 5. Configure Native Module Rebuilding
**File**: `netaris-elektron/package.json`

Add electron-rebuild configuration or electron-builder configuration to ensure better-sqlite3's native bindings are rebuilt for the correct Electron version during:
- Development (`npm install`)
- Packaging (pre-build step)

### 6. Test Database Integration

Test scenarios:
- Database initialization on first run
- Data persistence across app restarts
- Database migration/schema updates
- Concurrent access handling
- Error handling for disk full, permission issues, etc.

### 7. Packaging Considerations

When packaging the Electron app:
- Ensure better-sqlite3 native module is included and correctly rebuilt
- Test on all target platforms (macOS, Windows, Linux)
- Verify database file location and permissions
- Test with both development and production builds

## Schema Design
*(To be determined based on specific use case)*

Initial tables might include:
- User preferences/settings
- Cached data
- Offline content
- Application state

## Security Considerations

- Keep database in user data directory (not app installation directory)
- Validate all inputs before database operations
- Use prepared statements (better-sqlite3 does this by default)
- No direct SQL from renderer process
- All database operations through IPC with validation

## Migration Strategy

For future schema changes:
- Version the database schema
- Store schema version in database
- Run migrations on app startup if version mismatch
- Keep migrations in separate files for maintainability

## Rollback Plan

If integration causes issues:
- better-sqlite3 is optional/fallback
- Graceful degradation if database fails to initialize
- Clear error messages to users
- Database file can be deleted to reset state
