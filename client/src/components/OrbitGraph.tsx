/** Obsidian-style graph of notes and chats in the active vault. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchVaultGraph, type VaultGraph, type VaultGraphKind, type VaultGraphNode } from '../api';
import { kineticEnergy, neighborIds, stepForce, type ForceBody } from '../orbitForce';

type Pos = { x: number; y: number };
type DragState =
  | { mode: 'pan'; startX: number; startY: number; origin: Pos }
  | { mode: 'node'; id: string; startX: number; startY: number; origin: Pos }
  | null;
type Filter = 'all' | 'note' | 'chat';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.8;

function seedPosition(index: number): Pos {
  const angle = index * (Math.PI * 2 * 0.61803398875);
  const radius = 48 + Math.sqrt(index + 1) * 36;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function nodeRadius(node: VaultGraphNode, degree: number) {
  const base = node.kind === 'chat' ? 6.5 : node.kind === 'missing' ? 4.5 : 6;
  return base + Math.min(8, degree) * 0.7 + Math.min(4, (node.wordCount || 0) / 180);
}

function normalizeGraph(raw: VaultGraph): VaultGraph {
  const nodes = (raw.nodes || []).map((node) => ({
    ...node,
    kind: (node.kind === 'chat' || node.kind === 'missing' ? node.kind : 'note') as VaultGraphKind,
    title: node.title || 'Untitled',
  }));
  const known = new Set(nodes.map((node) => node.id));
  const edges = (raw.edges || []).filter((edge) => known.has(edge.source) && known.has(edge.target));
  return { nodes, edges };
}

export function OrbitGraph({ vaultId, onOpenNote }: { vaultId?: string | null; onOpenNote?: (id: string) => void }) {
  const [graph, setGraph] = useState<VaultGraph>({ nodes: [], edges: [] });
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<ForceBody[]>([]);
  const [surfaceSize, setSurfaceSize] = useState({ w: 0, h: 0 });
  const dragRef = useRef<DragState>(null);
  const nodeMovedRef = useRef(false);
  const bodiesRef = useRef(bodies);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const graphRef = useRef(graph);
  const frameRef = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  bodiesRef.current = bodies;
  panRef.current = pan;
  zoomRef.current = zoom;
  graphRef.current = graph;

  useEffect(() => {
    if (!vaultId) {
      setGraph({ nodes: [], edges: [] });
      return;
    }
    let alive = true;
    void fetchVaultGraph(vaultId)
      .then((next) => {
        if (!alive) return;
        const normalized = normalizeGraph(next);
        setGraph(normalized);
        setError('');
        setBodies((previous) => {
          const kept = new Map(previous.map((body) => [body.id, body]));
          return normalized.nodes.map((node, index) => kept.get(node.id) || {
            id: node.id,
            ...seedPosition(index),
            vx: 0,
            vy: 0,
          });
        });
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : 'Could not load graph');
      });
    return () => { alive = false; };
  }, [vaultId]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      let current = bodiesRef.current;
      for (let i = 0; i < 60; i += 1) current = stepForce(current, graphRef.current.edges.map((edge) => ({ from: edge.source, to: edge.target })));
      setBodies(current);
      return;
    }
    const tick = () => {
      const drag = dragRef.current;
      const pinnedId = drag?.mode === 'node' ? drag.id : null;
      const links = graphRef.current.edges.map((edge) => ({ from: edge.source, to: edge.target }));
      const current = bodiesRef.current.map((body) => (
        body.id === pinnedId ? { ...body, pinned: true, vx: 0, vy: 0 } : { ...body, pinned: false }
      ));
      const stepped = stepForce(current, links);
      if (kineticEnergy(stepped) > 0.04 || pinnedId) setBodies(stepped);
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameRef.current);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const scale = zoomRef.current;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    if (drag.mode === 'node' && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) nodeMovedRef.current = true;
    if (drag.mode === 'pan') setPan({ x: drag.origin.x + (event.clientX - drag.startX), y: drag.origin.y + (event.clientY - drag.startY) });
    else {
      setBodies((previous) => previous.map((body) => (
        body.id === drag.id
          ? { ...body, x: drag.origin.x + dx, y: drag.origin.y + dy, vx: 0, vy: 0, pinned: true }
          : body
      )));
    }
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  const startPan = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragRef.current = { mode: 'pan', startX: event.clientX, startY: event.clientY, origin: panRef.current };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  }, [endDrag, onPointerMove]);

  const startNodeDrag = useCallback((event: React.PointerEvent, id: string) => {
    event.stopPropagation();
    nodeMovedRef.current = false;
    const body = bodiesRef.current.find((entry) => entry.id === id);
    dragRef.current = {
      mode: 'node',
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: body?.x || 0, y: body?.y || 0 },
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  }, [endDrag, onPointerMove]);

  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
    const previous = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, previous * (event.deltaY < 0 ? 1.08 : 0.92)));
    const factor = next / previous;
    setZoom(next);
    setPan({
      x: cursor.x - (cursor.x - panRef.current.x) * factor,
      y: cursor.y - (cursor.y - panRef.current.y) * factor,
    });
  }, []);

  useEffect(() => () => endDrag(), [endDrag]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      const rect = surface.getBoundingClientRect();
      setSurfaceSize({ w: rect.width, h: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const nodes = graph.nodes.filter((node) => {
      if (filter !== 'all' && node.kind !== filter && node.kind !== 'missing') return false;
      if (filter === 'chat' && node.kind === 'missing') return false;
      if (!needle) return true;
      return node.title.toLocaleLowerCase().includes(needle);
    });
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
    return { nodes, edges };
  }, [filter, graph, query]);

  const hoverNeighbors = hoverId ? neighborIds(visible.edges.map((edge) => ({ from: edge.source, to: edge.target })), hoverId) : null;
  const degrees = new Map<string, number>();
  for (const edge of visible.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }

  return (
    <div
      ref={surfaceRef}
      className="orbit-graph"
      onPointerDown={startPan}
      onWheel={onWheel}
      style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}
    >
      <div className="orbit-graph-header">
        <span className="surface-kicker">Vault</span>
        <h2>Graph</h2>
        <div className="orbit-graph-controls">
          <input
            className="orbit-graph-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter notes"
            aria-label="Filter graph"
            onPointerDown={(event) => event.stopPropagation()}
          />
          {(['all', 'note', 'chat'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`orbit-graph-filter${filter === value ? ' is-active' : ''}`}
              aria-pressed={filter === value}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? 'All' : value === 'note' ? 'Notes' : 'Chats'}
            </button>
          ))}
        </div>
      </div>
      <div className="orbit-graph-hint">Scroll to zoom · drag to pan</div>

      {visible.nodes.length === 0 && <div className="orbit-empty">{error || 'No notes in this vault'}</div>}

      <svg className="orbit-edges" aria-hidden="true">
        <g transform={`translate(${surfaceSize.w / 2 + pan.x}, ${surfaceSize.h / 2 + pan.y}) scale(${zoom})`}>
          {visible.edges.map((edge) => {
            const from = bodies.find((body) => body.id === edge.source);
            const to = bodies.find((body) => body.id === edge.target);
            if (!from || !to) return null;
            const hot = Boolean(hoverId && (edge.source === hoverId || edge.target === hoverId));
            const dim = Boolean(hoverId && !hot);
            return (
              <line
                key={`${edge.source}->${edge.target}->${edge.kind || 'wikilink'}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={`orbit-edge-line${edge.kind === 'chat' ? ' is-chat' : ''}${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`}
              />
            );
          })}
        </g>
      </svg>

      <div className="orbit-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {visible.nodes.map((node) => {
          const body = bodies.find((entry) => entry.id === node.id);
          if (!body) return null;
          const dim = Boolean(hoverId && hoverId !== node.id && !hoverNeighbors?.has(node.id));
          const radius = nodeRadius(node, degrees.get(node.id) || 0);
          return (
            <div
              key={node.id}
              className={`orbit-node is-${node.kind}${node.archived ? ' is-idle' : ''}${node.kind !== 'missing' ? ' is-linked' : ''}${dim ? ' is-dim' : ''}${hoverId === node.id ? ' is-focus' : ''}`}
              style={{ left: body.x, top: body.y }}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
              onPointerEnter={() => setHoverId(node.id)}
              onPointerLeave={() => setHoverId((current) => current === node.id ? null : current)}
              onClick={() => {
                if (!nodeMovedRef.current && node.kind !== 'missing') onOpenNote?.(node.id);
              }}
            >
              <span className="orbit-dot" style={{ width: radius * 2, height: radius * 2 }} />
              <span className="orbit-node-meta">
                <span className="orbit-node-label">{node.title}</span>
                <span className="orbit-node-status">{node.kind === 'chat' ? 'chat' : node.kind === 'missing' ? 'unresolved' : ''}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
