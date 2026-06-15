import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// ── Helpers ────────────────────────────────────────────────────────
function sanitizeFilename(title) {
    return title
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'Untitled';
}
function stripMarkdown(content) {
    return content
        .replace(/^#{1,6}\s+/gm, '') // headings
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1') // italic
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1') // strikethrough
        .replace(/`([^`]+)`/g, '$1') // inline code
        .replace(/```[\s\S]*?```/g, '') // code blocks
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
        .replace(/\[\[([^\]]+)\]\]/g, '$1') // wikilinks
        .replace(/[-*+]\s+/g, '') // list markers
        .replace(/>\s+/g, '') // blockquotes
        .replace(/\n{2,}/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
}
function makePreview(content) {
    const stripped = stripMarkdown(content);
    return stripped.length > 200 ? stripped.slice(0, 200) : stripped;
}
function wordCount(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return 0;
    return trimmed.split(/\s+/).length;
}
export function extractLinks(content) {
    const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    const titles = [];
    for (const match of matches) {
        const title = match[1].trim();
        if (title && !titles.includes(title))
            titles.push(title);
    }
    return titles;
}
function getNotePath(vault, folderName, title) {
    const filename = `${sanitizeFilename(title)}.md`;
    if (folderName) {
        return path.join(vault.root_path, folderName, filename);
    }
    return path.join(vault.root_path, filename);
}
function getFolderPath(vault, db, folderId) {
    const parts = [];
    let current = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(folderId);
    while (current) {
        parts.unshift(current.name);
        if (current.parent_id) {
            current = db.prepare('SELECT id, parent_id, name FROM folders WHERE id = ?').get(current.parent_id);
        }
        else {
            break;
        }
    }
    return path.join(vault.root_path, ...parts);
}
function getVaultForNote(db, noteId) {
    const note = db.prepare('SELECT vault_id FROM notes WHERE id = ?').get(noteId);
    if (!note)
        return undefined;
    return db.prepare('SELECT * FROM vaults WHERE id = ?').get(note.vault_id);
}
function resolveNotePath(db, noteId) {
    const note = db.prepare('SELECT id, vault_id, folder_id, title FROM notes WHERE id = ?').get(noteId);
    if (!note)
        return undefined;
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(note.vault_id);
    if (!vault)
        return undefined;
    if (note.folder_id) {
        const folderPath = getFolderPath(vault, db, note.folder_id);
        return path.join(folderPath, `${sanitizeFilename(note.title)}.md`);
    }
    return path.join(vault.root_path, `${sanitizeFilename(note.title)}.md`);
}
function getTagsForNote(db, noteId) {
    const rows = db.prepare(`
    SELECT t.name FROM tags t
    JOIN note_tags nt ON nt.tag_id = t.id
    WHERE nt.note_id = ?
    ORDER BY t.name ASC
  `).all(noteId);
    return rows.map((r) => r.name);
}
function reIndexLinks(db, noteId, vaultId, content) {
    db.prepare('DELETE FROM note_links WHERE source_id = ?').run(noteId);
    const titles = extractLinks(content);
    if (titles.length === 0)
        return;
    const insert = db.prepare('INSERT OR REPLACE INTO note_links (source_id, target_id, target_title, context) VALUES (?, ?, ?, ?)');
    for (const title of titles) {
        // Try to resolve target_id by matching title in the same vault
        const target = db.prepare('SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE').get(vaultId, title);
        // Extract some context around the link
        const linkPattern = `[[${title}]]`;
        const idx = content.indexOf(linkPattern);
        let context = null;
        if (idx !== -1) {
            const start = Math.max(0, idx - 40);
            const end = Math.min(content.length, idx + linkPattern.length + 40);
            context = content.slice(start, end).replace(/\n/g, ' ').trim();
        }
        insert.run(noteId, target?.id || null, title, context);
    }
}
// ── Schema ─────────────────────────────────────────────────────────
export function ensureVaultSchema(_db) {
    // Schema is created in index.ts — this is a hook for future migrations
}
// ── Vaults ─────────────────────────────────────────────────────────
export function listVaults(db, userId) {
    return db.prepare('SELECT * FROM vaults WHERE created_by = ? ORDER BY created_at DESC').all(userId);
}
export function getVault(db, vaultId, userId) {
    return db.prepare('SELECT * FROM vaults WHERE id = ? AND created_by = ?').get(vaultId, userId);
}
function prepopulateWalkthrough(vault) {
    const welcomeContent = `# 💎 Welcome to Cascade Notes\n\nCascade Notes is an intelligent, Obsidian-style personal wiki designed for writing, organizing, and thinking alongside AI.\n\n## Key Features\n\n1. **Local Markdown Files**: All notes are stored as standard \`.md\` files in your vault folder: \`${vault.root_path}\`.\n2. **Rich Live Preview**: A modern CodeMirror 6 editor renders headers, bold/italic, checkboxes, and wikilinks directly as you type.\n3. **Wikilinks & Backlinks**: Connect notes using wikilinks like [[LLM Directives Guide]] or [[Navigation & Search]]. Check the backlinks panel to explore note relationships.\n4. **Intelligent Directives**: Prompt LLMs directly inside your notes to summarize, expand, outline, or query your vault!\n\n## Get Started\n\n- Open the [[LLM Directives Guide]] to learn how to prompt AI inline.\n- Check the boxes below to try out interactive checklists:\n  - [ ] Edit this note and change this checkbox\n  - [ ] Click on the checkbox widget directly to toggle it!\n  - [x] Press \`Ctrl+P\` to open the command palette\n  - [ ] Press \`Ctrl+Shift+Enter\` to run the directives in this note\n`;
    const directivesContent = `# ✨ LLM Directives Guide\n\nCascade Notes lets you embed AI directives directly inside your notes. There are two primary types of directives: inline directives and block directives.\n\n## 1. Inline Directives\n\nInline directives use the \`{{ai: prompt}}\` syntax. They are excellent for quick edits, expansions, or summaries.\n\nTry running the directive below:\n{{ai: write a short, motivational quote about note-taking}}\n\n### How to Run:\n1. Move your cursor onto the line containing the directive (or click it).\n2. Click the **⚡ Run AI** button at the top-right of the editor toolbar, or press \`Ctrl+Shift+Enter\` (\`Cmd+Shift+Enter\` on macOS).\n3. The backend will parse the note, call the model, and replace the directive with the generated response!\n\n## 2. Block Directives\n\nBlock directives use the \` \`\`\`llm \` code block syntax. They are ideal for longer prompts, multi-note summaries, or generating structured tables.\n\nTry running this block:\n\`\`\`llm\nSummarize the key features of Cascade Notes from the welcome note [[Welcome to Cascade Notes]].\n\`\`\`\n\n## 3. Note-Aware Agent Runner\n\nFor larger tasks (e.g. searching across the entire vault, creating new notes, or organizing tags), click the **✨ AI Assistant** button on the tab bar to open the AI panel. The agent can use advanced tools to operate on files directly on disk.\n`;
    const navContent = `# 🔍 Navigation & Search\n\nCascade Notes is built for speed and keyboard-driven navigation.\n\n## Keyboard Shortcuts\n\nHere are the key shortcuts to keep your hands on the keyboard:\n\n- \`Ctrl+P\` (or \`Cmd+P\`): Open the **Command Palette**. Search through note titles fuzzy-style, or press Enter on a non-existent name to create a new note instantly.\n- \`Ctrl+Shift+F\`: Open **Vault Search**. Perform ranked full-text search across all note contents using SQLite FTS5.\n- \`Ctrl+S\`: Save the current note.\n- \`Ctrl+N\`: Create a new note.\n- \`Ctrl+\\\`: Toggle the sidebar.\n\n## Organizing with Tags\n\nYou can add tags to notes (e.g., #tutorial, #reference) or add them via the tag manager in the sidebar. Tags help you filter notes in search and group them in the folder tree.\n`;
    fs.writeFileSync(path.join(vault.root_path, 'Welcome to Cascade Notes.md'), welcomeContent, 'utf8');
    fs.writeFileSync(path.join(vault.root_path, 'LLM Directives Guide.md'), directivesContent, 'utf8');
    fs.writeFileSync(path.join(vault.root_path, 'Navigation & Search.md'), navContent, 'utf8');
}
export function createVault(db, userId, opts) {
    const id = crypto.randomUUID();
    const name = String(opts.name || 'My Vault').trim() || 'My Vault';
    const rootPath = path.resolve(String(opts.root_path || path.join(process.cwd(), 'vaults', sanitizeFilename(name))));
    fs.mkdirSync(rootPath, { recursive: true });
    db.prepare('INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)').run(id, name, rootPath, userId);
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(id);
    try {
        prepopulateWalkthrough(vault);
        rescanVault(db, vault.id, userId);
    }
    catch (err) {
        console.error('Failed to prepopulate vault walkthrough:', err);
    }
    return vault;
}
// ── Folders ────────────────────────────────────────────────────────
export function listFolders(db, vaultId) {
    return db.prepare('SELECT * FROM folders WHERE vault_id = ? ORDER BY position ASC, name ASC').all(vaultId);
}
export function createFolder(db, vaultId, opts) {
    const id = crypto.randomUUID();
    const name = String(opts.name || 'New Folder').trim() || 'New Folder';
    const parentId = opts.parent_id || null;
    // Calculate next position
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM folders WHERE vault_id = ? AND parent_id IS ?').get(vaultId, parentId);
    db.prepare('INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)').run(id, vaultId, parentId, name, maxPos.next);
    // Create directory on disk
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId);
    if (vault) {
        const folderPath = getFolderPath(vault, db, id);
        fs.mkdirSync(folderPath, { recursive: true });
    }
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
}
export function updateFolder(db, folderId, opts) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder)
        throw new Error('Folder not found');
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(folder.vault_id);
    const oldPath = getFolderPath(vault, db, folderId);
    const name = opts.name !== undefined ? String(opts.name).trim() || folder.name : folder.name;
    const parentId = opts.parent_id !== undefined ? opts.parent_id : folder.parent_id;
    const position = opts.position !== undefined ? opts.position : folder.position;
    db.prepare('UPDATE folders SET name = ?, parent_id = ?, position = ? WHERE id = ?').run(name, parentId, position, folderId);
    // Rename directory on disk if path changed
    const newPath = getFolderPath(vault, db, folderId);
    if (oldPath !== newPath && fs.existsSync(oldPath)) {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
    }
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
}
export function deleteFolder(db, folderId) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder)
        throw new Error('Folder not found');
    // Move notes in this folder to parent folder (or root)
    db.prepare('UPDATE notes SET folder_id = ? WHERE folder_id = ?').run(folder.parent_id, folderId);
    // Move child folders to parent
    db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(folder.parent_id, folderId);
    // Delete the folder record
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    // Optionally remove the directory on disk (only if empty)
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(folder.vault_id);
    if (vault) {
        const folderPath = getFolderPath(vault, db, folderId);
        try {
            if (fs.existsSync(folderPath)) {
                const entries = fs.readdirSync(folderPath);
                if (entries.length === 0)
                    fs.rmdirSync(folderPath);
            }
        }
        catch {
            // Ignore cleanup failures
        }
    }
}
// ── Notes ──────────────────────────────────────────────────────────
export function listNotes(db, vaultId, opts) {
    let sql = `
    SELECT n.id, n.vault_id, n.folder_id, n.title, n.content_preview,
           n.is_pinned, n.is_archived, n.word_count, n.created_at, n.updated_at
    FROM notes n
    WHERE n.vault_id = ?
  `;
    const params = [vaultId];
    if (opts?.folder_id !== undefined) {
        if (opts.folder_id === '') {
            sql += ' AND n.folder_id IS NULL';
        }
        else {
            sql += ' AND n.folder_id = ?';
            params.push(opts.folder_id);
        }
    }
    if (opts?.is_archived !== undefined) {
        sql += ' AND n.is_archived = ?';
        params.push(opts.is_archived ? 1 : 0);
    }
    if (opts?.tag) {
        sql += ` AND EXISTS (
      SELECT 1 FROM note_tags nt
      JOIN tags t ON t.id = nt.tag_id
      WHERE nt.note_id = n.id AND t.name = ? COLLATE NOCASE
    )`;
        params.push(opts.tag);
    }
    sql += ' ORDER BY n.is_pinned DESC, n.updated_at DESC';
    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
        ...row,
        tags: getTagsForNote(db, row.id),
    }));
}
export function getNote(db, noteId) {
    const row = db.prepare(`
    SELECT id, vault_id, folder_id, title, content_preview,
           is_pinned, is_archived, word_count, created_at, updated_at
    FROM notes WHERE id = ?
  `).get(noteId);
    if (!row)
        return undefined;
    const filePath = resolveNotePath(db, noteId);
    if (!filePath)
        return undefined;
    let content = '';
    try {
        content = fs.readFileSync(filePath, 'utf8');
    }
    catch {
        // Fall back to DB content if file is missing
        const dbRow = db.prepare('SELECT content FROM notes WHERE id = ?').get(noteId);
        content = dbRow?.content || '';
    }
    return {
        ...row,
        tags: getTagsForNote(db, noteId),
        content,
        file_path: filePath,
    };
}
export function createNote(db, vaultId, userId, opts) {
    const id = crypto.randomUUID();
    const title = String(opts.title || 'Untitled').trim() || 'Untitled';
    const content = String(opts.content || '');
    const folderId = opts.folder_id || null;
    const preview = makePreview(content);
    const wc = wordCount(content);
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId);
    if (!vault)
        throw new Error('Vault not found');
    // Determine file path
    let filePath;
    if (folderId) {
        const folderPath = getFolderPath(vault, db, folderId);
        fs.mkdirSync(folderPath, { recursive: true });
        filePath = path.join(folderPath, `${sanitizeFilename(title)}.md`);
    }
    else {
        filePath = path.join(vault.root_path, `${sanitizeFilename(title)}.md`);
    }
    // Write .md file to disk
    fs.writeFileSync(filePath, content, 'utf8');
    // Insert DB row
    db.prepare(`
    INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, word_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run(id, vaultId, folderId, title, content, preview, wc, userId);
    // Index links
    reIndexLinks(db, id, vaultId, content);
    return getNote(db, id);
}
export function updateNote(db, noteId, content) {
    const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!existing)
        throw new Error('Note not found');
    const preview = makePreview(content);
    const wc = wordCount(content);
    // Write to .md file
    const filePath = resolveNotePath(db, noteId);
    if (filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    }
    // Update DB
    db.prepare(`
    UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(content, preview, wc, noteId);
    // Re-index links
    reIndexLinks(db, noteId, existing.vault_id, content);
    return getNote(db, noteId);
}
export function deleteNote(db, noteId) {
    // Remove .md file from disk
    const filePath = resolveNotePath(db, noteId);
    if (filePath) {
        try {
            if (fs.existsSync(filePath))
                fs.unlinkSync(filePath);
        }
        catch {
            // Ignore file deletion failures
        }
    }
    db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
}
export function moveNote(db, noteId, folderId) {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId);
    if (!note)
        throw new Error('Note not found');
    const oldPath = resolveNotePath(db, noteId);
    db.prepare('UPDATE notes SET folder_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(folderId, noteId);
    const newPath = resolveNotePath(db, noteId);
    // Move file on disk
    if (oldPath && newPath && oldPath !== newPath) {
        try {
            if (fs.existsSync(oldPath)) {
                fs.mkdirSync(path.dirname(newPath), { recursive: true });
                fs.renameSync(oldPath, newPath);
            }
        }
        catch {
            // Ignore move failures
        }
    }
}
export function togglePin(db, noteId) {
    db.prepare('UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}
export function toggleArchive(db, noteId) {
    db.prepare('UPDATE notes SET is_archived = CASE WHEN is_archived = 0 THEN 1 ELSE 0 END, updated_at = datetime(\'now\') WHERE id = ?').run(noteId);
}
// ── Search ─────────────────────────────────────────────────────────
export function searchNotes(db, vaultId, query) {
    if (!query.trim())
        return [];
    // Use FTS5 MATCH with snippet
    const rows = db.prepare(`
    SELECT n.id, n.title, snippet(notes_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet, rank
    FROM notes_fts
    JOIN notes n ON n.rowid = notes_fts.rowid
    WHERE notes_fts MATCH ? AND n.vault_id = ?
    ORDER BY rank
    LIMIT 50
  `).all(query, vaultId);
    return rows;
}
// ── Backlinks ──────────────────────────────────────────────────────
export function getBacklinks(db, noteId) {
    // Find notes that link to this note by ID or by title
    const note = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(noteId);
    if (!note)
        return [];
    const rows = db.prepare(`
    SELECT DISTINCT n.id, n.title, nl.context
    FROM note_links nl
    JOIN notes n ON n.id = nl.source_id
    WHERE nl.target_id = ? OR nl.target_title = ? COLLATE NOCASE
  `).all(noteId, note.title);
    return rows;
}
// ── Tags ───────────────────────────────────────────────────────────
export function listTags(db, vaultId) {
    return db.prepare(`
    SELECT t.id, t.name, t.color, COUNT(nt.note_id) AS count
    FROM tags t
    LEFT JOIN note_tags nt ON nt.tag_id = t.id
    WHERE t.vault_id = ?
    GROUP BY t.id
    ORDER BY t.name ASC
  `).all(vaultId);
}
export function addTag(db, noteId, vaultId, name, color) {
    const tagName = String(name).trim().toLowerCase();
    if (!tagName)
        throw new Error('Tag name is required');
    // Upsert the tag
    let tag = db.prepare('SELECT id FROM tags WHERE vault_id = ? AND name = ?').get(vaultId, tagName);
    if (!tag) {
        const tagId = crypto.randomUUID();
        db.prepare('INSERT INTO tags (id, vault_id, name, color) VALUES (?, ?, ?, ?)').run(tagId, vaultId, tagName, color || null);
        tag = { id: tagId };
    }
    else if (color) {
        db.prepare('UPDATE tags SET color = ? WHERE id = ?').run(color, tag.id);
    }
    // Link tag to note
    db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tag.id);
}
export function removeTag(db, noteId, tagId) {
    db.prepare('DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?').run(noteId, tagId);
    // Clean up orphan tags (no notes using them)
    const count = db.prepare('SELECT COUNT(*) AS c FROM note_tags WHERE tag_id = ?').get(tagId);
    if (count.c === 0) {
        db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    }
}
// ── Graph ──────────────────────────────────────────────────────────
export function getGraph(db, vaultId) {
    const nodes = db.prepare(`
    SELECT id, title, folder_id FROM notes WHERE vault_id = ?
  `).all(vaultId);
    const edges = db.prepare(`
    SELECT nl.source_id AS source, nl.target_id AS target
    FROM note_links nl
    JOIN notes n ON n.id = nl.source_id
    WHERE n.vault_id = ? AND nl.target_id IS NOT NULL
  `).all(vaultId);
    return { nodes, edges };
}
// ── Directory scan & sync helpers ──────────────────────────────────
function scanDirRecursive(dirPath) {
    let results = [];
    if (!fs.existsSync(dirPath))
        return results;
    try {
        const list = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of list) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(scanDirRecursive(fullPath));
            }
            else if (entry.isFile() && entry.name.endsWith('.md')) {
                results.push(fullPath);
            }
        }
    }
    catch (err) {
        console.error('Error scanning directory:', err);
    }
    return results;
}
export function rescanVault(db, vaultId, userId) {
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId);
    if (!vault)
        return;
    const filesOnDisk = scanDirRecursive(vault.root_path);
    // 1. Delete notes in DB that no longer exist on disk
    const existingNotes = db.prepare('SELECT id, title FROM notes WHERE vault_id = ?').all(vaultId);
    for (const note of existingNotes) {
        const filePath = resolveNotePath(db, note.id);
        if (!filePath || !fs.existsSync(filePath)) {
            db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
        }
    }
    // 2. Add or update notes from disk
    for (const filePath of filesOnDisk) {
        const resolvedPath = path.resolve(filePath);
        const relPath = path.relative(vault.root_path, resolvedPath);
        const pathParts = relPath.split(path.sep);
        let folderId = null;
        let currentParentId = null;
        // Create folders in DB if they do not exist
        if (pathParts.length > 1) {
            for (let i = 0; i < pathParts.length - 1; i++) {
                const folderName = pathParts[i];
                let folder = db.prepare('SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND name = ?').get(vaultId, currentParentId, folderName);
                if (!folder) {
                    const newId = crypto.randomUUID();
                    db.prepare('INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, 0)').run(newId, vaultId, currentParentId, folderName);
                    folder = { id: newId };
                }
                currentParentId = folder.id;
            }
            folderId = currentParentId;
        }
        const filename = pathParts[pathParts.length - 1];
        const title = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
        // Check if note exists in DB
        const note = db.prepare('SELECT id, content FROM notes WHERE vault_id = ? AND title = ? AND (folder_id IS ? OR folder_id = ?)').get(vaultId, title, folderId, folderId);
        const content = fs.readFileSync(resolvedPath, 'utf8');
        const preview = makePreview(content);
        const wc = wordCount(content);
        if (note) {
            if (note.content !== content) {
                db.prepare(`
          UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(content, preview, wc, note.id);
                reIndexLinks(db, note.id, vaultId, content);
            }
        }
        else {
            const noteId = crypto.randomUUID();
            db.prepare(`
        INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, word_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(noteId, vaultId, folderId, title, content, preview, wc, userId);
            reIndexLinks(db, noteId, vaultId, content);
        }
    }
}
