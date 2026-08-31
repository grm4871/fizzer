import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OrbitGraph } from '../components/OrbitGraph';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchVaultGraph: vi.fn(async () => ({
      nodes: [
        { id: 'n1', title: 'Roadmap', kind: 'note', wordCount: 40, archived: 0 },
        { id: 'c1', title: 'new-channel', kind: 'chat', wordCount: 0, archived: 0 },
      ],
      edges: [{ source: 'c1', target: 'n1', kind: 'chat' }],
    })),
  };
});

describe('Orbit graph view', () => {
  it('renders vault graph chrome with note and chat filters', () => {
    const markup = renderToStaticMarkup(createElement(OrbitGraph, { vaultId: 'vault-1' }));
    expect(markup).toContain('orbit-graph');
    expect(markup).toContain('>Graph<');
    expect(markup).toContain('Notes');
    expect(markup).toContain('Chats');
    expect(markup).toContain('Filter notes');
    expect(markup).not.toContain('orbit-codex-mark');
    expect(markup).not.toContain('Running agents');
  });
});
