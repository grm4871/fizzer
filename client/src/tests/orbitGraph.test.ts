import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OrbitGraph } from '../components/OrbitGraph';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchLocalAgents: vi.fn(async () => ({
      nodes: [
        {
          id: 'a',
          kind: 'codex',
          role: 'parent',
          label: 'jt',
          status: 'Running a command',
          action: '',
          state: 'active',
          updatedAt: 1,
        },
        {
          id: 'b',
          kind: 'claude',
          role: 'parent',
          label: 'claude',
          status: 'Idle',
          action: '',
          state: 'idle',
          updatedAt: 1,
        },
      ],
      edges: [{ from: 'a', to: 'b' }],
      scannedAt: 1,
    })),
  };
});

describe('Orbit graph view', () => {
  it('renders the graph chrome without agent logos', () => {
    const markup = renderToStaticMarkup(createElement(OrbitGraph, {}));
    expect(markup).toContain('orbit-graph');
    expect(markup).toContain('>Graph<');
    expect(markup).toContain('Scroll to zoom');
    expect(markup).not.toContain('orbit-codex-mark');
    expect(markup).not.toContain('▐▛███▜▌');
  });
});
