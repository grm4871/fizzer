/** Obsidian-style graph of currently-running local Claude Code and Codex sessions. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  api,
  appendOrbitCaption,
  fetchLocalAgents,
  type LocalAgentGraph,
  type LocalAgentNode,
  type Note,
} from '../api';
import { kineticEnergy, neighborIds, stepForce, type ForceBody } from '../orbitForce';

type Pos = { x: number; y: number };
type DragState =
  | { mode: 'pan'; startX: number; startY: number; origin: Pos }
  | { mode: 'node'; id: string; startX: number; startY: number; origin: Pos }
  | null;

const POLL_MS = 750;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 2.8;

function seedPosition(node: LocalAgentNode, parent: Pos | undefined, index: number): Pos {
  if (node.role === 'child' && parent) {
    const angle = (index % 6) * (Math.PI / 3);
    return { x: parent.x + Math.cos(angle) * 120, y: parent.y + Math.sin(angle) * 120 };
  }
  const angle = index * (Math.PI * 2 * 0.61803398875);
  const radius = 70 + index * 38;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function nodeRadius(node: LocalAgentNode, degree: number) {
  const base = node.role === 'parent' ? 7 : 5.5;
  const live = node.state === 'active' ? 1.6 : 0;
  return base + Math.min(4, degree) * 0.8 + live;
}

type ActivityRef = { sessionId: string; title: string };

export function OrbitGraph({ promptNoteId, captionLogNoteId, onOpenActivity }: { promptNoteId?: string; captionLogNoteId?: string; onOpenActivity?: (activity: ActivityRef) => void }) {
  const [template, setTemplate] = useState('');
  const [promptReady, setPromptReady] = useState(false);
  const [graph, setGraph] = useState<LocalAgentGraph | null>(null);
  const [error, setError] = useState('');
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
  const loggedCaptionsRef = useRef(new Map<string, string>());
  const frameRef = useRef(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  bodiesRef.current = bodies;
  panRef.current = pan;
  zoomRef.current = zoom;
  graphRef.current = graph;

  useEffect(() => {
    let alive = true;
    setPromptReady(false);
    if (!promptNoteId) {
      setTemplate('');
      setPromptReady(true);
      return () => { alive = false; };
    }
    void api<{ note: Note }>(`/api/notes/${encodeURIComponent(promptNoteId)}`)
      .then(({ note }) => {
        if (!alive) return;
        setTemplate(note.content);
        setError('');
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : 'Could not load prompt note');
      })
      .finally(() => {
        if (alive) setPromptReady(true);
      });
    return () => { alive = false; };
  }, [promptNoteId]);

  useEffect(() => {
    if (!promptReady) return;
    let alive = true;
    const load = async () => {
      try {
        const next = await fetchLocalAgents(template);
        if (!alive) return;
        setGraph(next);
        setError('');
        if (captionLogNoteId) {
          for (const node of next.nodes) {
            if (!node.captioned || !node.status.trim()) continue;
            if (loggedCaptionsRef.current.get(node.id) === node.status) continue;
            loggedCaptionsRef.current.set(node.id, node.status);
            void appendOrbitCaption(captionLogNoteId, node).catch(() => {
              loggedCaptionsRef.current.delete(node.id);
            });
          }
        }
        setBodies((previous) => {
          const kept = new Map(previous.map((body) => [body.id, body]));
          return next.nodes.map((node, index) => {
            const existing = kept.get(node.id);
            if (existing) return existing;
            const parentEdge = next.edges.find((edge) => edge.to === node.id);
            const parent = parentEdge ? kept.get(parentEdge.from) : undefined;
            const seed = seedPosition(node, parent, index);
            return { id: node.id, x: seed.x, y: seed.y, vx: 0, vy: 0 };
          });
        });
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : 'Could not load agents');
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [captionLogNoteId, promptReady, template]);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      let current = bodiesRef.current;
      for (let i = 0; i < 60; i += 1) current = stepForce(current, graphRef.current?.edges || []);
      setBodies(current);
      return;
    }
    const tick = () => {
      const drag = dragRef.current;
      const pinnedId = drag?.mode === 'node' ? drag.id : null;
      const current = bodiesRef.current.map((body) => (
        body.id === pinnedId ? { ...body, pinned: true, vx: 0, vy: 0 } : { ...body, pinned: false }
      ));
      const stepped = stepForce(current, graphRef.current?.edges || []);
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

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const hoverNeighbors = hoverId ? neighborIds(edges, hoverId) : null;
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) || 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) || 0) + 1);
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
        <span className="surface-kicker">Live activity</span>
        <h2>Graph</h2>
      </div>
      <div className="orbit-graph-hint">Scroll to zoom · drag to pan</div>

      {nodes.length === 0 && <div className="orbit-empty">{error || 'No agents running'}</div>}

      <svg className="orbit-edges" aria-hidden="true">
        <g transform={`translate(${surfaceSize.w / 2 + pan.x}, ${surfaceSize.h / 2 + pan.y}) scale(${zoom})`}>
          {edges.map((edge) => {
            const from = bodies.find((body) => body.id === edge.from);
            const to = bodies.find((body) => body.id === edge.to);
            if (!from || !to) return null;
            const hot = Boolean(hoverId && (edge.from === hoverId || edge.to === hoverId));
            const dim = Boolean(hoverId && !hot);
            return (
              <line
                key={`${edge.from}->${edge.to}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={`orbit-edge-line${hot ? ' is-hot' : ''}${dim ? ' is-dim' : ''}`}
              />
            );
          })}
        </g>
      </svg>

      <div className="orbit-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        {nodes.map((node) => {
          const body = bodies.find((entry) => entry.id === node.id);
          if (!body) return null;
          const dim = Boolean(hoverId && hoverId !== node.id && !hoverNeighbors?.has(node.id));
          const radius = nodeRadius(node, degrees.get(node.id) || 0);
          return (
            <div
              key={node.id}
              className={`orbit-node is-${node.kind} is-${node.role} is-${node.state}${node.activity ? ' is-linked' : ''}${dim ? ' is-dim' : ''}${hoverId === node.id ? ' is-focus' : ''}`}
              style={{ left: body.x, top: body.y }}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
              onPointerEnter={() => setHoverId(node.id)}
              onPointerLeave={() => setHoverId((current) => current === node.id ? null : current)}
              onClick={() => {
                if (!nodeMovedRef.current && node.activity) onOpenActivity?.(node.activity);
              }}
            >
              <span className="orbit-dot" style={{ width: radius * 2, height: radius * 2 }} />
              <span className="orbit-node-meta">
                <span className="orbit-node-label">{node.label}</span>
                <span className="orbit-node-status" title={node.status}>{node.status}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
