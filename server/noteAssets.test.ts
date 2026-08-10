import assert from 'node:assert/strict';
import test from 'node:test';
import { assetBytesMatchMediaType, decodeAssetData } from './noteAssets.js';

test('asset base64 decoding rejects ignored junk instead of silently stripping it', () => {
  assert.deepEqual(decodeAssetData('aGVs bG8='), Buffer.from('hello'));
  assert.deepEqual(decodeAssetData('aGVsbG8'), Buffer.from('hello'));
  assert.throws(() => decodeAssetData('aGVsbG8=<script>'), /valid base64/);
  assert.throws(() => decodeAssetData('%%%'), /valid base64/);
  assert.throws(() => decodeAssetData(''), /valid base64/);
});

test('asset signatures accept supported media and reject disguised active content', () => {
  const samples: Array<[string, Buffer]> = [
    ['image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
    ['image/jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', Buffer.from('GIF89a')],
    ['image/webp', Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary')],
    ['audio/mpeg', Buffer.from('ID3\x04\x00\x00', 'binary')],
    ['audio/mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64])],
    ['video/mp4', Buffer.from('\x00\x00\x00\x18ftypisom', 'binary')],
  ];
  for (const [mediaType, bytes] of samples) {
    assert.equal(assetBytesMatchMediaType(mediaType, bytes), true, mediaType);
  }

  const html = Buffer.from('<!doctype html><script>alert(1)</script>');
  for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'audio/mpeg', 'video/mp4']) {
    assert.equal(assetBytesMatchMediaType(mediaType, html), false, mediaType);
  }
  assert.equal(assetBytesMatchMediaType('image/svg+xml', Buffer.from('<svg onload="alert(1)">')), false);
  assert.equal(assetBytesMatchMediaType('image/bmp', Buffer.from('BM')), false);
});
