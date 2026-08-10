import assert from 'node:assert/strict';
import test from 'node:test';
import { clientAssetCacheControl } from './staticAssets.js';

test('fingerprinted client assets are immutable for one year', () => {
  assert.equal(
    clientAssetCacheControl('/app/client/dist/assets/main-AbCd1234.js'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    clientAssetCacheControl('C:\\app\\client\\dist\\assets\\main-AbCd1234.css'),
    'public, max-age=31536000, immutable',
  );
});

test('client entrypoints and version sentinel always revalidate', () => {
  assert.equal(clientAssetCacheControl('/app/client/dist/app.html'), 'no-cache');
  assert.equal(clientAssetCacheControl('/app/client/dist/index.html'), 'no-cache');
  assert.equal(clientAssetCacheControl('/app/client/dist/version.json'), 'no-store');
  assert.equal(clientAssetCacheControl('/app/client/dist/gem.svg'), undefined);
});
