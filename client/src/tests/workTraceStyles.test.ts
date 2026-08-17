import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('work-trace surface', () => {
  it('does not nest a second card around the harness inside FLOW', () => {
    expect(styles).toMatch(
      /\.chat-work-trace \.cascade-run-panel[\s\S]{0,240}border:\s*0/,
    );
    expect(styles).toMatch(
      /\.chat-work-trace \.cascade-run-panel \.crp-term[\s\S]{0,280}overflow:\s*visible/,
    );
    expect(styles).toMatch(
      /\.chat-work-trace \.crp-term-pre[\s\S]{0,200}overflow:\s*visible/,
    );
    expect(styles).toMatch(
      /\.chat-work-line-body:has\(\.cascade-run-panel\)[\s\S]{0,160}border-left:\s*0/,
    );
  });
});
