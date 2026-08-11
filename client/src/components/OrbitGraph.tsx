/** Interactive graph of recently-active local Claude Code and Codex sessions. */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
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

const POLL_MS = 2_000;
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
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function OrbitGraph({ promptNoteId }: { promptNoteId?: string }) {
  const [template, setTemplate] = useState('');
  const [promptReady, setPromptReady] = useState(false);
  const [graph, setGraph] = useState<LocalAgentGraph | null>(null);
  const [error, setError] = useState('');
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const dragRef = useRef<DragState>(null);
  const positionsRef = useRef(positions);
  const panRef = useRef(pan);
  positionsRef.current = positions;
  panRef.current = pan;

  useEffect(() => {
    let alive = true;
    setPromptReady(false);
    if (!promptNoteId) {
      setTemplate('');
      setError('Create a note named prompt to caption activity');
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
        if (template) setError('');
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
  }, [promptReady, template]);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
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
    <div className="orbit-graph" onPointerDown={startPan}>
      <div className="orbit-graph-header">
        <span className="surface-kicker">Recent activity</span>
        <h2>Running agents</h2>
      </div>

      {nodes.length === 0 && <div className="orbit-empty">{error || 'No recent activity'}</div>}

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
              className={`orbit-node is-${node.kind} is-${node.role}`}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
            >
              <div className="orbit-node-icon">
                {node.kind === 'claude' ? <pre className="orbit-claude-art">{CLAUDE_ART}</pre> : <CodexMark />}
              </div>
              <div className="orbit-node-meta">
                <span className="orbit-node-label">{node.label}</span>
                <span className="orbit-node-status" title={node.status}>{node.status}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
