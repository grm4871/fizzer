/**
 * @file noteAssets.ts — Image assets stored alongside vault notes
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { getNote, getVault, getWritableVault } from './vault.js';

type Db = Database.Database;

export const NOTE_ASSET_MAX_BYTES = 8 * 1024 * 1024;

const IMG_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

const ASSET_EXT: Record<string, string> = {
  ...IMG_EXT,
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'video/mp4': 'mp4',
};

export function noteAssetsDir(db: Db, noteId: string): string | null {
  const note = getNote(db, noteId);
  if (!note) return null;
  const vault = db.prepare('SELECT root_path FROM vaults WHERE id = ?').get(note.vault_id) as { root_path: string } | undefined;
  if (!vault) return null;
  return path.join(vault.root_path, '.cascade-assets', noteId);
}

export function deleteNoteAssets(db: Db, noteId: string): void {
  const dir = noteAssetsDir(db, noteId);
  if (!dir || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

export function uploadNoteAsset(
  db: Db,
  noteId: string,
  userId: number,
  input: { media_type: string; data: string; filename?: string },
): { asset_id: string; url: string; filename: string } {
  const note = getNote(db, noteId);
  if (!note) throw new Error('Note not found');
  const vault = getWritableVault(db, note.vault_id, userId);
  if (!vault) throw new Error('Note not found');

  const mediaType = String(input.media_type || '').trim().toLowerCase();
  if (
    !mediaType.startsWith('image/')
    && mediaType !== 'audio/mpeg'
    && mediaType !== 'audio/mp3'
    && mediaType !== 'video/mp4'
  ) {
    throw new Error('Only image, MP3, and MP4 uploads are supported');
  }

  const data = String(input.data || '').trim();
  if (!data) throw new Error('Asset data is required');

  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) throw new Error('Asset data is required');
  if (buffer.length > NOTE_ASSET_MAX_BYTES) {
    throw new Error(`Asset is too large (max ${NOTE_ASSET_MAX_BYTES / (1024 * 1024)}MB)`);
  }

  const assetId = crypto.randomBytes(12).toString('base64url');
  const ext = ASSET_EXT[mediaType] || 'bin';
  const dir = noteAssetsDir(db, noteId);
  if (!dir) throw new Error('Note not found');

  fs.mkdirSync(dir, { recursive: true });
  const filename = `${assetId}.${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);

  return {
    asset_id: assetId,
    url: `/api/notes/${noteId}/assets/${assetId}`,
    filename,
  };
}

export function resolveNoteAssetPath(db: Db, noteId: string, assetId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(assetId)) return null;
  const dir = noteAssetsDir(db, noteId);
  if (!dir || !fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir);
  const match = files.find((file) => file.startsWith(`${assetId}.`));
  if (!match) return null;
  return path.join(dir, match);
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function serveNoteAsset(db: Db) {
  return (req: Request, res: Response) => {
    const note = getNote(db, req.params.id);
    if (!note) return res.status(404).json({ error: 'Not found' });

    const userId = (req as Request & { user?: { id: number } }).user?.id;
    if (!userId || !getVault(db, note.vault_id, userId)) return res.status(404).json({ error: 'Not found' });

    const filePath = resolveNoteAssetPath(db, req.params.id, req.params.assetId);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

    const ext = path.extname(filePath).slice(1).toLowerCase();
    res.setHeader('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(filePath);
  };
}
