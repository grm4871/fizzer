import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { publicBaseUrl, renderPublicMarkdown } from './publish.js';

test('published markdown allowlists link and image URL schemes', () => {
  assert.match(renderPublicMarkdown('[safe](https://example.com/a?b=1)'), /href="https:\/\/example\.com\/a\?b=1"/);
  assert.match(renderPublicMarkdown('[mail](mailto:person@example.com)'), /href="mailto:person@example\.com"/);
  assert.match(renderPublicMarkdown('[local](/notes/one)'), /href="\/notes\/one"/);
  assert.match(renderPublicMarkdown('![image](https://example.com/image.png)'), /src="https:\/\/example\.com\/image\.png"/);

  for (const markdown of [
    '[x](javascript:alert(1))',
    '[x](java&#x73;cript:alert(1))',
    '[x](jav%61script:alert(1))',
    '[x](java%2561script:alert(1))',
    '[x](data:text/html,boom)',
    '[x](//evil.example/path)',
  ]) {
    assert.doesNotMatch(renderPublicMarkdown(markdown), /javascript:|&#x73;|%61|%2561|data:text\/html|evil\.example/i);
  }
});

test('published image data is limited to passive raster formats', () => {
  assert.match(renderPublicMarkdown('![png](data:image/png;base64,iVBORw0KGgo=)'), /src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(renderPublicMarkdown('![svg](data:image/svg+xml;base64,PHN2Zz4=)'), /src=/);
  assert.doesNotMatch(renderPublicMarkdown('![html](data:text/html;base64,PGgxPng8L2gxPg==)'), /src=/);
});

test('published markdown strips raw active HTML', () => {
  const html = renderPublicMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.doesNotMatch(html, /<script|<img|onerror/i);
});

test('public URLs ignore forwarded-host injection and prefer configured origins', () => {
  const req = {
    protocol: 'https',
    get: (name: string) => ({
      host: 'cscd.online',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
    })[name.toLowerCase()],
  } as unknown as Request;
  assert.equal(publicBaseUrl(req, { CASCADE_ALLOWED_ORIGINS: 'https://cscd.online' }), 'https://cscd.online');
  assert.equal(publicBaseUrl(req, { CASCADE_PUBLIC_URL: 'https://www.cscd.online/path' }), 'https://www.cscd.online');
  assert.throws(() => publicBaseUrl(req, { CASCADE_PUBLIC_URL: 'javascript:alert(1)' }), /absolute HTTP/);
});
