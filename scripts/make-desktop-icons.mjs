#!/usr/bin/env node
/**
 * Regenerate the desktop app icons from cascade-electron/assets/icon.svg.
 *
 * The generated icon.png / icon.icns / icon.ico are committed, because the
 * hosted runners that build installers have neither rsvg-convert nor an ICNS
 * encoder. Run this only when the artwork changes:
 *
 *   node scripts/make-desktop-icons.mjs
 *
 * Needs rsvg-convert (librsvg) and magick (ImageMagick) locally.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'cascade-electron', 'assets');
const source = path.join(assets, 'icon.svg');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-icons-'));

const render = (size) => {
  const out = path.join(work, `icon-${size}.png`);
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), source, '-o', out]);
  return out;
};

/**
 * ICNS is a flat container: 'icns' + total length, then typed entries whose
 * length includes their own 8-byte header. Modern OS types take raw PNG, so
 * no ARGB encoder is needed.
 */
const ICNS_TYPES = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

function buildIcns() {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = fs.readFileSync(render(size));
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

fs.copyFileSync(render(1024), path.join(assets, 'icon.png'));
fs.writeFileSync(path.join(assets, 'icon.icns'), buildIcns());
execFileSync('magick', [
  ...[16, 24, 32, 48, 64, 128, 256].map(render),
  path.join(assets, 'icon.ico'),
]);

fs.rmSync(work, { recursive: true, force: true });
process.stdout.write(`wrote icon.png, icon.icns, icon.ico to ${assets}\n`);
