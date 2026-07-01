import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { highlightJSON } from '../components/jsonHighlighter';

describe('JSON Syntax Highlighter', () => {
  it('should format a basic JSON string with proper styling classes', () => {
    const json = `{
      "name": "Cascade",
      "version": 1.2,
      "active": true,
      "metadata": null
    }`;
    const nodes = highlightJSON(json);
    const html = renderToString(<>{nodes}</>);

    // Verify key highlight
    expect(html).toContain('class="json-token-key"');
    expect(html).toContain('name');

    // Verify string highlight
    expect(html).toContain('class="json-token-string"');
    expect(html).toContain('Cascade');

    // Verify number highlight
    expect(html).toContain('class="json-token-number"');
    expect(html).toContain('1.2');

    // Verify boolean highlight
    expect(html).toContain('class="json-token-boolean"');
    expect(html).toContain('true');

    // Verify null highlight
    expect(html).toContain('class="json-token-null"');
    expect(html).toContain('null');

    // Verify punctuation highlight
    expect(html).toContain('class="json-token-punctuation"');
  });
});
