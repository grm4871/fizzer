import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { VaultGraph } from '../api';
import {
  createConstellation,
  fitConstellation,
  OrbitGraph,
  visibleLabelIds,
} from '../components/OrbitGraph';

describe('Orbit graph view', () => {
  it('renders vault graph chrome with note and chat filters', () => {
    const markup = renderToStaticMarkup(createElement(OrbitGraph, { vaultId: 'vault-1' }));
    expect(markup).toContain('orbit-graph');
    expect(markup).toContain('>Vault atlas<');
    expect(markup).toContain('Notes');
    expect(markup).toContain('Chats');
    expect(markup).toContain('Find a note or chat');
    expect(markup).toContain('note link');
    expect(markup).toContain('chat reference');
    expect(markup).not.toContain('orbit-codex-mark');
    expect(markup).not.toContain('Running agents');
  });

  it('keeps realistic default density to structural note labels and reveals local context', () => {
    const graph = realisticGraph();
    const baseline = visibleLabelIds(graph, 0.5, null);
    expect(baseline.size).toBe(8);
    expect([...baseline].every((id) => graph.nodes.find((node) => node.id === id)?.kind === 'note')).toBe(true);
    expect(baseline.has('note-0')).toBe(true);

    const zoomed = visibleLabelIds(graph, 1.8, null);
    expect(zoomed.size).toBeGreaterThan(baseline.size);
    expect(zoomed.size).toBeLessThanOrEqual(38);

    const localTrail = visibleLabelIds(graph, 0.5, 'chat-0');
    expect(localTrail.has('chat-0')).toBe(true);
    expect(localTrail.has('note-0')).toBe(true);
  });

  it('spreads and frames a realistic vault instead of collapsing it at the origin', () => {
    const bodies = createConstellation(realisticGraph());
    const xs = bodies.map((body) => body.x);
    const ys = bodies.map((body) => body.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(900);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(600);
    const camera = fitConstellation(bodies, 1120, 780);
    expect(camera.zoom).toBeGreaterThanOrEqual(0.35);
    expect(camera.zoom).toBeLessThan(0.8);
  });
});

function realisticGraph(): VaultGraph {
  const notes = Array.from({ length: 96 }, (_, index) => ({
    id: `note-${index}`,
    title: index === 0 ? 'Index of working ideas' : `Note ${index}`,
    kind: 'note' as const,
    wordCount: index === 0 ? 2400 : 80 + (index % 11) * 45,
    archived: index > 88 ? 1 : 0,
  }));
  const chats = Array.from({ length: 20 }, (_, index) => ({
    id: `chat-${index}`,
    title: `Conversation ${index}`,
    kind: 'chat' as const,
    wordCount: 0,
    archived: 0,
  }));
  const missing = Array.from({ length: 4 }, (_, index) => ({
    id: `missing-${index}`,
    title: `Unresolved ${index}`,
    kind: 'missing' as const,
    wordCount: 0,
    archived: 0,
  }));
  return {
    nodes: [...notes, ...chats, ...missing],
    edges: [
      ...notes.slice(1).map((note, index) => ({
        source: note.id,
        target: index < 28 ? 'note-0' : `note-${Math.floor(index / 3)}`,
        kind: 'wikilink' as const,
      })),
      ...chats.map((chat, index) => ({
        source: chat.id,
        target: `note-${index * 3}`,
        kind: 'chat' as const,
      })),
      ...missing.map((node, index) => ({
        source: `note-${index + 4}`,
        target: node.id,
        kind: 'wikilink' as const,
      })),
    ],
  };
}
