/** Interactive graph of currently-running local Claude Code and Codex sessions. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  appendOrbitCaption,
  fetchLocalAgents,
  type LocalAgentGraph,
  type LocalAgentNode,
  type Note,
} from '../api';

type Pos = { x: number; y: number };
type DragState =
  | { mode: 'pan'; startX: number; startY: number; origin: Pos }
  | { mode: 'node'; id: string; startX: number; startY: number; origin: Pos }
  | null;

const POLL_MS = 750;
const CLAUDE_ART = ['▐▛███▜▌', '▝▜█████▛▘', '▘▘ ▝▝'].join('\n');

function seedPosition(node: LocalAgentNode, parent: Pos | undefined, index: number): Pos {
  if (node.role === 'child' && parent) {
    const angle = (index % 6) * (Math.PI / 3);
    return { x: parent.x + Math.cos(angle) * 120, y: parent.y + Math.sin(angle) * 120 };
  }
  const angle = index * (Math.PI * 2 * 0.61803398875);
  const radius = 90 + index * 46;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function CodexMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true" className="orbit-codex-mark">
      <path
        fill="currentColor"
        d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z"
      />
    </svg>
  );
}

type ActivityRef = { sessionId: string; title: string };

export function OrbitGraph({ promptNoteId, captionLogNoteId, onOpenActivity }: { promptNoteId?: string; captionLogNoteId?: string; onOpenActivity?: (activity: ActivityRef) => void }) {
  const [template, setTemplate] = useState('');
  const [promptReady, setPromptReady] = useState(false);
  const [graph, setGraph] = useState<LocalAgentGraph | null>(null);
  const [error, setError] = useState('');
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const dragRef = useRef<DragState>(null);
  const nodeMovedRef = useRef(false); // true once a node drag actually moved, so a trailing click is a real click
  const positionsRef = useRef(positions);
  const panRef = useRef(pan);
  const loggedCaptionsRef = useRef(new Map<string, string>());
  positionsRef.current = positions;
  panRef.current = pan;

  useEffect(() => {
    let alive = true;
    setPromptReady(false);
    if (!promptNoteId) {
      // No note id supplied — the server falls back to reading the "prompt" note.
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
        setPositions((previous) => {
          const merged = { ...previous };
          next.nodes.forEach((node, index) => {
            if (merged[node.id]) return;
            const parentEdge = next.edges.find((edge) => edge.to === node.id);
            merged[node.id] = seedPosition(node, parentEdge ? merged[parentEdge.from] : undefined, index);
          });
          return merged;
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

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === 'node' && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) nodeMovedRef.current = true;
    if (drag.mode === 'pan') setPan({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    else setPositions((previous) => ({
      ...previous,
      [drag.id]: { x: drag.origin.x + dx, y: drag.origin.y + dy },
    }));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  const startPan = useCallback((event: React.PointerEvent) => {
    dragRef.current = { mode: 'pan', startX: event.clientX, startY: event.clientY, origin: panRef.current };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  }, [endDrag, onPointerMove]);

  const startNodeDrag = useCallback((event: React.PointerEvent, id: string) => {
    event.stopPropagation();
    nodeMovedRef.current = false;
    dragRef.current = {
      mode: 'node',
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin: positionsRef.current[id] || { x: 0, y: 0 },
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  }, [endDrag, onPointerMove]);

  useEffect(() => () => endDrag(), [endDrag]);

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  return (
    <div className="orbit-graph" onPointerDown={startPan} style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}>
      <div className="orbit-graph-header">
        <span className="surface-kicker">Live activity</span>
        <h2>Running agents</h2>
      </div>

      {nodes.length === 0 && <div className="orbit-empty">{error || 'No agents running'}</div>}

      <svg className="orbit-edges" aria-hidden="true">
        <g transform={`translate(${pan.x}, ${pan.y})`}>
          {edges.map((edge) => {
            const from = positions[edge.from];
            const to = positions[edge.to];
            if (!from || !to) return null;
            return <line key={`${edge.from}->${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="orbit-edge-line" />;
          })}
        </g>
      </svg>

      <div className="orbit-layer" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {nodes.map((node) => {
          const position = positions[node.id];
          if (!position) return null;
          return (
            <div
              key={node.id}
              className={`orbit-node is-${node.kind} is-${node.role} is-${node.state}${node.activity ? ' is-linked' : ''}`}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
              onClick={() => {
                if (!nodeMovedRef.current && node.activity) onOpenActivity?.(node.activity);
              }}
            >
              <div className="orbit-node-icon">
                {node.kind === 'claude' ? <pre className="orbit-claude-art">{CLAUDE_ART}</pre> : <CodexMark />}
              </div>
              <div className="orbit-node-meta">
                <span className="orbit-node-label">{node.label}</span>
                <span className="orbit-node-status" title={node.status}>{node.status}</span>
                {node.action && <span className="orbit-node-action">{node.action}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
