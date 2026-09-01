/** A navigable constellation of notes and chats in the active vault. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fetchVaultGraph, type VaultGraph, type VaultGraphKind, type VaultGraphNode } from '../api';
import { neighborIds, stepForce, type ForceBody } from '../orbitForce';

type Pos = { x: number; y: number };
type DragState =
  | { mode: 'pan'; startX: number; startY: number; origin: Pos }
  | { mode: 'node'; id: string; startX: number; startY: number; origin: Pos }
  | null;
type Filter = 'all' | 'note' | 'chat';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.8;
const CAMERA_PADDING = 150;

function normalizeGraph(raw: VaultGraph): VaultGraph {
  const nodes = (raw.nodes || []).map((node) => ({
    ...node,
    kind: (node.kind === 'chat' || node.kind === 'missing' ? node.kind : 'note') as VaultGraphKind,
    title: node.title || 'Untitled',
  }));
  const known = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: (raw.edges || []).filter((edge) => known.has(edge.source) && known.has(edge.target)),
  };
}

export function graphDegrees(graph: VaultGraph) {
  const degrees = new Map<string, number>();
  for (const edge of graph.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  return degrees;
}

export function nodeImportance(node: VaultGraphNode, degree: number) {
  const content = Math.log2(Math.max(1, (node.wordCount || 0) + 1)) * 0.34;
  const kindWeight = node.kind === 'note' ? 1 : node.kind === 'chat' ? 0.42 : 0.2;
  const archiveWeight = node.archived ? 0.6 : 1;
  return (1 + Math.min(12, degree) + content) * kindWeight * archiveWeight;
}

function nodeRadius(node: VaultGraphNode, degree: number) {
  const base = node.kind === 'note' ? 5.5 : node.kind === 'chat' ? 3.75 : 3;
  return base + Math.min(node.kind === 'note' ? 9 : 5, nodeImportance(node, degree) * 0.62);
}

/** Keep the default view sparse; detail arrives with intent (zoom, search, or a local trail). */
export function visibleLabelIds(
  graph: VaultGraph,
  zoom: number,
  activeId: string | null,
  query = '',
  baseCap = Number.POSITIVE_INFINITY,
  localCap = 5,
) {
  const degrees = graphDegrees(graph);
  const ranked = [...graph.nodes].sort((left, right) => {
    if (left.kind === 'note' && right.kind !== 'note') return -1;
    if (right.kind === 'note' && left.kind !== 'note') return 1;
    return nodeImportance(right, degrees.get(right.id) || 0) - nodeImportance(left, degrees.get(left.id) || 0);
  });
  const density = graph.nodes.length;
  const preferredNoteLimit = density <= 18 ? density : zoom < 0.7 ? 8 : zoom < 1.15 ? 12 : zoom < 1.7 ? 18 : 24;
  const noteLimit = Math.min(preferredNoteLimit, baseCap);
  const visible = new Set(ranked.filter((node) => node.kind === 'note').slice(0, noteLimit).map((node) => node.id));
  if (zoom >= 1.7) {
    for (const node of ranked.filter((entry) => entry.kind !== 'note').slice(0, 4)) visible.add(node.id);
  }
  const needle = query.trim().toLocaleLowerCase();
  if (needle) {
    for (const node of graph.nodes) {
      if (node.title.toLocaleLowerCase().includes(needle)) visible.add(node.id);
    }
  }
  if (activeId) {
    visible.add(activeId);
    const neighbors = neighborIds(graph.edges.map((edge) => ({ from: edge.source, to: edge.target })), activeId);
    for (const node of ranked.filter((entry) => neighbors.has(entry.id)).slice(0, localCap)) {
      visible.add(node.id);
    }
  }
  return visible;
}

export function createConstellation(graph: VaultGraph) {
  const degrees = graphDegrees(graph);
  const ordered = [...graph.nodes].sort((left, right) => {
    const importance = nodeImportance(right, degrees.get(right.id) || 0)
      - nodeImportance(left, degrees.get(left.id) || 0);
    return importance || left.id.localeCompare(right.id);
  });
  let bodies: ForceBody[] = ordered.map((node, index) => {
    const angle = index * Math.PI * 2 * 0.61803398875;
    const orbit = index === 0 ? 0 : 105 + Math.sqrt(index) * 76;
    const x = Math.cos(angle) * orbit * 1.24;
    const y = Math.sin(angle) * orbit * 0.78;
    const radius = nodeRadius(node, degrees.get(node.id) || 0);
    return {
      id: node.id,
      x,
      y,
      anchorX: x,
      anchorY: y,
      radius: radius + 8,
      mass: node.kind === 'note' ? 1.35 : 0.9,
      vx: 0,
      vy: 0,
    };
  });
  const links = graph.edges.map((edge) => ({ from: edge.source, to: edge.target }));
  const settleSteps = graph.nodes.length > 80 ? 110 : 80;
  for (let step = 0; step < settleSteps; step += 1) bodies = stepForce(bodies, links);
  return bodies;
}

export function fitConstellation(bodies: ForceBody[], width: number, height: number) {
  if (bodies.length === 0 || width <= 0 || height <= 0) return { zoom: 1, pan: { x: 0, y: 0 } };
  const minX = Math.min(...bodies.map((body) => body.x - (body.radius || 0)));
  const maxX = Math.max(...bodies.map((body) => body.x + (body.radius || 0)));
  const minY = Math.min(...bodies.map((body) => body.y - (body.radius || 0)));
  const maxY = Math.max(...bodies.map((body) => body.y + (body.radius || 0)));
  const availableWidth = Math.max(160, width - CAMERA_PADDING * 2);
  const availableHeight = Math.max(160, height - CAMERA_PADDING * 1.35);
  const zoom = Math.min(1.1, Math.max(MIN_ZOOM, Math.min(
    availableWidth / Math.max(1, maxX - minX),
    availableHeight / Math.max(1, maxY - minY),
  )));
  return {
    zoom,
    pan: { x: -((minX + maxX) / 2) * zoom, y: -((minY + maxY) / 2) * zoom },
  };
}

export function OrbitGraph({ vaultId, onOpenNote }: { vaultId?: string | null; onOpenNote?: (id: string) => void }) {
  const [graph, setGraph] = useState<VaultGraph>({ nodes: [], edges: [] });
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bodies, setBodies] = useState<ForceBody[]>([]);
  const [surfaceSize, setSurfaceSize] = useState({ w: 0, h: 0 });
  const dragRef = useRef<DragState>(null);
  const nodeMovedRef = useRef(false);
  const bodiesRef = useRef(bodies);
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const shouldFitRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  bodiesRef.current = bodies;
  panRef.current = pan;
  zoomRef.current = zoom;

  useEffect(() => {
    if (!vaultId) {
      setGraph({ nodes: [], edges: [] });
      setBodies([]);
      return;
    }
    let alive = true;
    void fetchVaultGraph(vaultId)
      .then((next) => {
        if (!alive) return;
        const normalized = normalizeGraph(next);
        setGraph(normalized);
        setBodies(createConstellation(normalized));
        setSelectedId(null);
        shouldFitRef.current = true;
        setError('');
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : 'Could not load graph');
      });
    return () => { alive = false; };
  }, [vaultId]);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const scale = zoomRef.current;
    const dx = (event.clientX - drag.startX) / scale;
    const dy = (event.clientY - drag.startY) / scale;
    if (drag.mode === 'node' && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) nodeMovedRef.current = true;
    if (drag.mode === 'pan') {
      setPan({ x: drag.origin.x + event.clientX - drag.startX, y: drag.origin.y + event.clientY - drag.startY });
    } else {
      setBodies((previous) => previous.map((body) => body.id === drag.id ? {
        ...body,
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
        anchorX: drag.origin.x + dx,
        anchorY: drag.origin.y + dy,
        vx: 0,
        vy: 0,
        pinned: true,
      } : body));
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
    setSelectedId(id);
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

  const onWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
    const previous = zoomRef.current;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, previous * (event.deltaY < 0 ? 1.1 : 0.9)));
    const factor = next / previous;
    setZoom(next);
    setPan({
      x: cursor.x - (cursor.x - panRef.current.x) * factor,
      y: cursor.y - (cursor.y - panRef.current.y) * factor,
    });
  }, []);

  const frameVault = useCallback(() => {
    const camera = fitConstellation(bodiesRef.current, surfaceSize.w, surfaceSize.h);
    setZoom(camera.zoom);
    setPan(camera.pan);
  }, [surfaceSize]);

  useEffect(() => () => endDrag(), [endDrag]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [onWheel]);

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

  useLayoutEffect(() => {
    if (!shouldFitRef.current || bodies.length === 0 || surfaceSize.w === 0) return;
    frameVault();
    shouldFitRef.current = false;
  }, [bodies.length, frameVault, surfaceSize.w]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const nodes = graph.nodes.filter((node) => {
      if (filter !== 'all' && node.kind !== filter && node.kind !== 'missing') return false;
      if (filter === 'chat' && node.kind === 'missing') return false;
      return !needle || node.title.toLocaleLowerCase().includes(needle);
    });
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
  }, [filter, graph, query]);

  const activeId = hoverId || selectedId;
  const activeNeighbors = activeId
    ? neighborIds(visible.edges.map((edge) => ({ from: edge.source, to: edge.target })), activeId)
    : null;
  const compact = surfaceSize.w > 0 && surfaceSize.w < 640;
  const labels = visibleLabelIds(visible, zoom, activeId, query, compact ? 4 : Number.POSITIVE_INFINITY, compact ? 4 : 5);
  const degrees = graphDegrees(visible);
  const noteCount = visible.nodes.filter((node) => node.kind === 'note').length;
  const chatCount = visible.nodes.filter((node) => node.kind === 'chat').length;
  const labelScale = Math.min(1.15, 1 / Math.max(zoom, 0.01));
  const captionedEdges = new Set<string>();
  const captionedRelations = new Set<string>();
  if (activeId) {
    for (const edge of visible.edges) {
      if (edge.source !== activeId && edge.target !== activeId) continue;
      const relation = edge.kind === 'chat' ? 'chat' : 'wikilink';
      if (captionedRelations.has(relation)) continue;
      captionedRelations.add(relation);
      captionedEdges.add(`${edge.source}->${edge.target}->${relation}`);
    }
  }

  return (
    <div
      ref={surfaceRef}
      className="orbit-graph"
      onPointerDown={startPan}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setSelectedId(null);
          setQuery('');
        }
      }}
    >
      <header className="orbit-graph-header orbit-graph-chrome">
        <span className="surface-kicker">Reading trails</span>
        <h2>Vault atlas</h2>
        <p>{noteCount} notes <span aria-hidden="true">/</span> {chatCount} chats</p>
        <div className="orbit-graph-controls">
          <input
            className="orbit-graph-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a note or chat"
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
          <button
            type="button"
            className="orbit-graph-frame"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={frameVault}
          >
            Frame vault
          </button>
        </div>
      </header>

      <aside className="orbit-graph-key orbit-graph-chrome" aria-label="Graph relation key">
        <span><i className="is-wikilink" /> note link</span>
        <span><i className="is-chat" /> chat reference</span>
      </aside>
      <div className="orbit-graph-hint">Scroll to reveal · drag to travel · Esc to clear</div>

      {visible.nodes.length === 0 && <div className="orbit-empty">{error || 'No matching notes in this vault'}</div>}

      <svg className="orbit-edges" aria-hidden="true">
        <g transform={`translate(${surfaceSize.w / 2 + pan.x}, ${surfaceSize.h / 2 + pan.y}) scale(${zoom})`}>
          {visible.edges.map((edge) => {
            const from = bodies.find((body) => body.id === edge.source);
            const to = bodies.find((body) => body.id === edge.target);
            if (!from || !to) return null;
            const hot = Boolean(activeId && (edge.source === activeId || edge.target === activeId));
            const dim = Boolean(activeId && !hot);
            const relation = edge.kind === 'chat' ? 'chat reference' : 'note link';
            const edgeKey = `${edge.source}->${edge.target}->${edge.kind || 'wikilink'}`;
            return (
              <g key={edgeKey}>
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  className={`orbit-edge-line${edge.kind === 'chat' ? ' is-chat' : ''}${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`}
                />
                {hot && captionedEdges.has(edgeKey) && (
                  <text className="orbit-edge-caption" x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 7}>
                    {relation}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="orbit-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {visible.nodes.map((node) => {
          const body = bodies.find((entry) => entry.id === node.id);
          if (!body) return null;
          const dim = Boolean(activeId && activeId !== node.id && !activeNeighbors?.has(node.id));
          const radius = nodeRadius(node, degrees.get(node.id) || 0);
          const labelVisible = labels.has(node.id);
          return (
            <button
              key={node.id}
              type="button"
              className={`orbit-node is-${node.kind}${node.archived ? ' is-idle' : ''}${dim ? ' is-dim' : ''}${activeId === node.id ? ' is-focus' : ''}`}
              style={{ left: body.x, top: body.y }}
              data-node-id={node.id}
              data-node-kind={node.kind}
              data-label-visible={labelVisible ? 'true' : 'false'}
              aria-label={`${node.title}, ${node.kind === 'missing' ? 'unresolved note' : node.kind}`}
              disabled={node.kind === 'missing'}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
              onPointerEnter={() => setHoverId(node.id)}
              onPointerLeave={() => setHoverId((current) => current === node.id ? null : current)}
              onFocus={() => setSelectedId(node.id)}
              onClick={() => {
                if (!nodeMovedRef.current && node.kind !== 'missing') onOpenNote?.(node.id);
              }}
            >
              <span className="orbit-dot" style={{ width: radius * 2, height: radius * 2 }} />
              <span
                className={`orbit-node-meta${labelVisible ? ' is-visible' : ''}`}
                style={{ '--orbit-label-scale': labelScale } as CSSProperties}
                aria-hidden={!labelVisible}
              >
                <span className="orbit-node-label">{node.title}</span>
                {node.kind !== 'note' && (
                  <span className="orbit-node-status">{node.kind === 'chat' ? 'chat' : 'unresolved'}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
