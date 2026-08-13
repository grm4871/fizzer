import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('work-trace surface', () => {
  it('gives the open FLOW stream one readable well', () => {
    expect(styles).toMatch(
      /\.chat-work-trace-body\s*\{[^}]*border:\s*1px solid/,
    );
  });

  it('does not nest a second card around the harness inside FLOW', () => {
    expect(styles).toMatch(
      /\.chat-work-trace \.cascade-run-panel[\s\S]{0,240}border:\s*0/,
    );
    expect(styles).toMatch(
      /\.chat-work-trace \.cascade-run-panel \.crp-term[\s\S]{0,160}max-height:\s*none/,
    );
    expect(styles).toMatch(
      /\.chat-work-line-body:has\(\.cascade-run-panel\)[\s\S]{0,160}border-left:\s*0/,
    );
  });
});
