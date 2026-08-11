/**
 * @file localAgents.ts — Discover locally-running Claude Code & Codex agents.
 *
 * This only returns anything meaningful when the server runs on the same machine
 * as the agents (i.e. the Fizzer desktop runner). In the cloud it degrades to an
 * empty graph. Everything here is best-effort and must never throw: a missing
 * `~/.claude` or `~/.codex`, a half-written JSONL line, or a locked SQLite file
 * all just mean "fewer nodes".
 *
 * Output is a flat graph the Orbit canvas renders:
 *   - nodes: { id, kind: 'claude' | 'codex', role: 'parent' | 'child', label, status }
 *   - edges: { from, to }   (parent -> subagent)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getCaption } from './agentCaptions.js';

export type LocalAgentKind = 'claude' | 'codex';

export type LocalAgentState = 'active' | 'idle';

export type LocalAgentNode = {
  id: string;
  kind: LocalAgentKind;
  role: 'parent' | 'child';
  label: string;
  /** Primary line: the qwen caption when available, else the heuristic verb / Idle. */
  status: string;
  /** Secondary line: the heuristic action verb, shown only when status is a qwen caption. */
  action: string;
  state: LocalAgentState;
  updatedAt: number;
  /** Present only for Cascade-spawned sessions: opens the Agent Sessions panel focused on this run. */
  activity?: { sessionId: string; title: string };
};

export type LocalAgentEdge = { from: string; to: string };

export type LocalAgentGraph = {
  nodes: LocalAgentNode[];
  edges: LocalAgentEdge[];
  scannedAt: number;
};

// An agent should vanish the instant it finishes. For Claude we detect "done"
// directly from the transcript (last turn ended), and only use a generous mtime
// cap to reap crashed sessions. Codex has no such signal, so it uses a short
// activity window instead.
const CLAUDE_ALIVE_WINDOW_MS = 5 * 60_000;
const CODEX_ACTIVE_WINDOW_MS = 90_000;

/** Map a Claude tool name to a short spinner-style verb (no XML, one line). */
function claudeVerbForTool(name: string | undefined): string {
  switch (name) {
    case 'Bash': return 'Running a command';
    case 'Read': return 'Reading a file';
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': return 'Editing code';
    case 'Grep':
    case 'Glob': return 'Searching the codebase';
    case 'Task': return 'Delegating to subagents';
    case 'WebFetch':
    case 'WebSearch': return 'Browsing the web';
    case 'TodoWrite': return 'Planning the work';
    default: return name ? `Using ${name}` : 'Thinking';
  }
}

/** Collapse whitespace/newlines and hard-truncate to one short line. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

type LastToolUse = { name?: string; id?: string };

/** Read the tail of a JSONL transcript without loading the whole file. */
function readTail(file: string, maxBytes = 96_000): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function decodeProjectLabel(dirName: string, cwd: string | undefined): string {
  if (cwd) return path.basename(cwd) || cwd;
  // Claude encodes the cwd into the dir name by replacing separators with '-'.
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

function scanClaude(now: number, template: string): { nodes: LocalAgentNode[]; edges: LocalAgentEdge[] } {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const nodes: LocalAgentNode[] = [];
  const edges: LocalAgentEdge[] = [];
  // Dedupe: many session-id transcripts can share one working directory (a
  // resumed/compacted session leaves several files). Keep only the most recently
  // written session per cwd so the same project shows a single node.
  type Candidate = { mtime: number; node: LocalAgentNode; children: LocalAgentNode[]; edges: LocalAgentEdge[] };
  const bestByCwd = new Map<string, Candidate>();
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(base);
  } catch {
    return { nodes, edges };
  }

  for (const dir of projectDirs) {
    const dirPath = path.join(base, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = path.join(dirPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs > CLAUDE_ALIVE_WINDOW_MS) continue; // crashed/abandoned — reap

      const sessionId = file.replace(/\.jsonl$/, '');
      let cwd: string | undefined;
      let lastToolUse: LastToolUse | undefined;
      let lastEventType: string | undefined;
      let lastStopReason: string | null | undefined;
      const snippets: string[] = []; // human-readable log excerpt for captioning
      // Track Task spawns and whether their result has come back yet.
      const openTasks = new Map<string, { desc: string; subagent: string }>();

      let lines: string[];
      try {
        lines = readTail(full).split('\n').filter(Boolean);
      } catch {
        continue;
      }
      for (const line of lines) {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue; // partial tail line
        }
        if (ev.cwd) cwd = ev.cwd;
        if (typeof ev.type === 'string') lastEventType = ev.type;
        const msg = ev.message;
        if (ev.type === 'assistant' && msg && typeof msg === 'object' && 'stop_reason' in msg) {
          lastStopReason = msg.stop_reason;
        }
        const content = msg && Array.isArray(msg.content) ? msg.content : [];
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'tool_use') {
            lastToolUse = { name: c.name, id: c.id };
            snippets.push(`[${c.name}]`);
            if (c.name === 'Task' && c.id) {
              const input = c.input || {};
              openTasks.set(c.id, {
                desc: String(input.description || 'subagent'),
                subagent: String(input.subagent_type || 'agent'),
              });
            }
          } else if (c.type === 'tool_result' && c.tool_use_id) {
            openTasks.delete(c.tool_use_id); // subagent finished
          } else if (c.type === 'text' && typeof c.text === 'string') {
            snippets.push(c.text);
          }
        }
      }

      // Done = the last thing in the transcript is a completed assistant turn
      // (waiting on the user). Drop it immediately so idle agents vanish at once.
      const done = lastEventType === 'assistant' && (lastStopReason === 'end_turn' || lastStopReason === 'stop_sequence');
      if (done) continue;

      const dedupeKey = cwd || dir;
      const existing = bestByCwd.get(dedupeKey);
      if (existing && existing.mtime >= stat.mtimeMs) continue; // keep the newer session

      const parentId = `claude:${sessionId}`;
      const excerpt = snippets.join('\n').slice(-1600);
      const verb = claudeVerbForTool(lastToolUse?.name);
      const caption = getCaption(parentId, template, excerpt);
      // When qwen has a caption, show it as the primary line and the heuristic
      // verb as a secondary line; otherwise the verb stands alone.
      const parentNode: LocalAgentNode = {
        id: parentId,
        kind: 'claude',
        role: 'parent',
        label: decodeProjectLabel(dir, cwd),
        status: caption || verb,
        action: caption ? verb : '',
        state: 'active',
        updatedAt: stat.mtimeMs,
      };
      const children: LocalAgentNode[] = [];
      const childEdges: LocalAgentEdge[] = [];
      for (const [taskId, task] of openTasks) {
        const childId = `claude:${sessionId}:${taskId}`;
        children.push({ id: childId, kind: 'claude', role: 'child', label: task.subagent, status: task.desc, action: '', state: 'active', updatedAt: stat.mtimeMs });
        childEdges.push({ from: parentId, to: childId });
      }
      bestByCwd.set(dedupeKey, { mtime: stat.mtimeMs, node: parentNode, children, edges: childEdges });
    }
  }

  for (const candidate of bestByCwd.values()) {
    nodes.push(candidate.node, ...candidate.children);
    edges.push(...candidate.edges);
  }
  return { nodes, edges };
}

function scanCodex(now: number, template: string): { nodes: LocalAgentNode[]; edges: LocalAgentEdge[] } {
  const nodes: LocalAgentNode[] = [];
  const edges: LocalAgentEdge[] = [];
  const home = path.join(os.homedir(), '.codex');
  const statePath = path.join(home, 'state_5.sqlite');
  const logsPath = path.join(home, 'logs_2.sqlite');
  if (!fs.existsSync(statePath)) return { nodes, edges };

  let state: Database.Database | undefined;
  let logs: Database.Database | undefined;
  try {
    state = new Database(statePath, { readonly: true, fileMustExist: true });
    // Most-recent log timestamp per thread tells us what is actually live.
    const lastLogByThread = new Map<string, number>();
    if (fs.existsSync(logsPath)) {
      try {
        logs = new Database(logsPath, { readonly: true, fileMustExist: true });
        const cutoffSec = Math.floor((now - CODEX_ACTIVE_WINDOW_MS) / 1000); // logs.ts is in seconds
        const rows = logs
          .prepare('SELECT thread_id, MAX(ts) AS ts FROM logs WHERE ts >= ? GROUP BY thread_id')
          .all(cutoffSec) as Array<{ thread_id: string | null; ts: number }>;
        for (const r of rows) {
          if (r.thread_id) lastLogByThread.set(r.thread_id, r.ts * 1000); // → ms
        }
      } catch {
        // logs db unavailable — fall back to thread updated_at below.
      }
    }

    const threadRows = state
      .prepare(
        `SELECT id, name, title, first_user_message, rollout_path, updated_at, updated_at_ms
         FROM threads WHERE archived = 0`,
      )
      .all() as Array<{
      id: string;
      name: string | null;
      title: string | null;
      first_user_message: string | null;
      rollout_path: string | null;
      updated_at: number | null;
      updated_at_ms: number | null;
    }>;

    const threadById = new Map<string, (typeof threadRows)[number]>();
    for (const t of threadRows) threadById.set(t.id, t);

    // Last activity per thread (ms), and which are recent enough to show at all.
    const lastActivityMs = new Map<string, number>();
    const running = new Set<string>();
    for (const t of threadRows) {
      const logMs = lastLogByThread.get(t.id) ?? 0;
      const updatedMs = t.updated_at_ms ?? (t.updated_at ? t.updated_at * 1000 : 0);
      const last = Math.max(logMs, updatedMs);
      lastActivityMs.set(t.id, last);
      if (last > 0 && now - last <= CODEX_ACTIVE_WINDOW_MS) running.add(t.id);
    }

    // Spawn edges: keep those whose parent is running; pull children in too.
    const spawnRows = state
      .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges WHERE status = 'open'")
      .all() as Array<{ parent_thread_id: string; child_thread_id: string }>;

    const childOf = new Set<string>();
    for (const e of spawnRows) {
      if (!running.has(e.parent_thread_id)) continue;
      running.add(e.child_thread_id);
      childOf.add(e.child_thread_id);
      edges.push({ from: `codex:${e.parent_thread_id}`, to: `codex:${e.child_thread_id}` });
    }

    for (const id of running) {
      const t = threadById.get(id);
      if (!t) continue;
      const label = oneLine(t.name || t.title || 'codex thread', 40);
      const nodeId = `codex:${id}`;
      let excerpt = '';
      if (t.rollout_path) {
        try {
          if (fs.existsSync(t.rollout_path)) excerpt = readTail(t.rollout_path).slice(-1600);
        } catch {
          /* rollout unreadable — no caption input */
        }
      }
      const status = getCaption(nodeId, template, excerpt) || oneLine(t.first_user_message || '', 60) || 'Working';
      const updatedMs = t.updated_at_ms ?? (t.updated_at ? t.updated_at * 1000 : now);
      nodes.push({
        id: nodeId,
        kind: 'codex',
        role: childOf.has(id) ? 'child' : 'parent',
        label,
        status,
        action: '', // no reliable per-tool verb parsed for Codex yet
        state: 'active',
        updatedAt: updatedMs,
      });
    }
    // Drop edges whose endpoints didn't make it into nodes.
    const nodeIds = new Set(nodes.map((n) => n.id));
    return { nodes, edges: edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)) };
  } catch {
    return { nodes, edges };
  } finally {
    try { state?.close(); } catch { /* ignore */ }
    try { logs?.close(); } catch { /* ignore */ }
  }
}

export function collectLocalAgents(template = '', now = Date.now()): LocalAgentGraph {
  const claude = scanClaude(now, template);
  const codex = scanCodex(now, template);
  return {
    nodes: [...claude.nodes, ...codex.nodes],
    edges: [...claude.edges, ...codex.edges],
    scannedAt: now,
  };
}
