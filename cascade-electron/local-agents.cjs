'use strict';

/** Discover recently-active local Claude Code and Codex sessions for Orbit. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createCaptioner } = require('./agent-captions.cjs');

const RUNNING_WINDOW_MS = 120_000;
const captioner = createCaptioner();

function oneLine(value, max = 60) {
  const flat = String(value || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function readTail(file, maxBytes = 192_000) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function claudeFallback(tool) {
  const labels = {
    Bash: 'Running a command',
    Read: 'Reading a file',
    Edit: 'Editing code',
    Write: 'Editing code',
    NotebookEdit: 'Editing code',
    Grep: 'Searching the codebase',
    Glob: 'Searching the codebase',
    Task: 'Delegating to subagents',
    WebFetch: 'Browsing the web',
    WebSearch: 'Browsing the web',
    TodoWrite: 'Planning the work',
  };
  return labels[tool] || (tool ? `Using ${tool}` : 'Thinking');
}

function claudeProjectLabel(dir, cwd) {
  if (cwd) return path.basename(cwd) || cwd;
  return dir.split('-').filter(Boolean).at(-1) || 'Claude';
}

function scanClaude(now, template, homeDir, captionService) {
  const nodes = [];
  const edges = [];
  const root = path.join(homeDir, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return { nodes, edges }; }

  for (const dir of dirs) {
    const projectDir = path.join(root, dir);
    let files = [];
    try { files = fs.readdirSync(projectDir).filter((file) => file.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const full = path.join(projectDir, file);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (now - stat.mtimeMs > RUNNING_WINDOW_MS) continue;

      const sessionId = file.slice(0, -'.jsonl'.length);
      let cwd = '';
      let lastTool = '';
      const snippets = [];
      const openTasks = new Map();
      let lines;
      try { lines = readTail(full).split('\n').filter(Boolean); } catch { continue; }
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (typeof event.cwd === 'string') cwd = event.cwd;
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'tool_use') {
            lastTool = String(block.name || '');
            const input = block.input && typeof block.input === 'object'
              ? oneLine(JSON.stringify(block.input), 360)
              : '';
            snippets.push(`${lastTool}${input ? ` ${input}` : ''}`);
            if (lastTool === 'Task' && block.id) {
              openTasks.set(block.id, {
                label: oneLine(block.input?.subagent_type || 'Claude subagent', 40),
                status: oneLine(block.input?.description || 'Working', 60),
              });
            }
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            openTasks.delete(block.tool_use_id);
          } else if (block.type === 'text' && typeof block.text === 'string') {
            snippets.push(oneLine(block.text, 500));
          }
        }
      }

      const id = `claude:${sessionId}`;
      const excerpt = snippets.filter(Boolean).slice(-20).join('\n').slice(-2400);
      // A recently-touched transcript containing only local slash commands is
      // not a running agent and gives the captioner nothing meaningful.
      if (!excerpt) continue;
      nodes.push({
        id,
        kind: 'claude',
        role: 'parent',
        label: claudeProjectLabel(dir, cwd),
        status: captionService.getCaption(id, template, excerpt) || claudeFallback(lastTool),
        updatedAt: stat.mtimeMs,
      });
      for (const [taskId, task] of openTasks) {
        const childId = `${id}:${taskId}`;
        nodes.push({ id: childId, kind: 'claude', role: 'child', ...task, updatedAt: stat.mtimeMs });
        edges.push({ from: id, to: childId });
      }
    }
  }
  return { nodes, edges };
}

function codexExcerpt(rolloutPath) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return '';
  const snippets = [];
  for (const line of readTail(rolloutPath).split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'response_item') continue;
    const item = event.payload || {};
    if (item.type === 'custom_tool_call') {
      snippets.push(`${item.name || 'tool'} ${oneLine(item.input, 500)}`);
    } else if (item.type === 'function_call') {
      snippets.push(`${item.name || 'tool'} ${oneLine(item.arguments, 500)}`);
    } else if (item.type === 'message' && item.role === 'assistant') {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => part?.text || '').join(' ')
        : item.content;
      if (text) snippets.push(oneLine(text, 500));
    }
  }
  return snippets.slice(-16).join('\n').slice(-2400);
}

function scanCodex(now, template, homeDir, captionService) {
  const nodes = [];
  let edges = [];
  const statePath = path.join(homeDir, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(statePath)) return { nodes, edges };
  let db;
  try {
    db = new DatabaseSync(statePath, { readOnly: true });
    const threads = db.prepare(
      `SELECT id, rollout_path, cwd, title, first_user_message, agent_nickname,
              agent_role, updated_at, updated_at_ms
       FROM threads WHERE archived = 0`,
    ).all();
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const active = new Set();
    for (const thread of threads) {
      const updatedAt = Number(thread.updated_at_ms || Number(thread.updated_at || 0) * 1000);
      if (updatedAt && now - updatedAt <= RUNNING_WINDOW_MS) active.add(thread.id);
    }

    const spawnRows = db.prepare(
      "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges WHERE status = 'open'",
    ).all();
    const children = new Set();
    for (const edge of spawnRows) {
      if (!active.has(edge.parent_thread_id)) continue;
      active.add(edge.child_thread_id);
      children.add(edge.child_thread_id);
      edges.push({ from: `codex:${edge.parent_thread_id}`, to: `codex:${edge.child_thread_id}` });
    }

    for (const id of active) {
      const thread = byId.get(id);
      if (!thread) continue;
      const nodeId = `codex:${id}`;
      const excerpt = codexExcerpt(thread.rollout_path);
      const fallback = template && excerpt ? 'Generating caption…' : 'Working';
      nodes.push({
        id: nodeId,
        kind: 'codex',
        role: children.has(id) ? 'child' : 'parent',
        label: oneLine(thread.agent_nickname || thread.agent_role || path.basename(thread.cwd || '') || 'Codex', 40),
        status: captionService.getCaption(nodeId, template, excerpt) || fallback,
        updatedAt: Number(thread.updated_at_ms || Number(thread.updated_at || 0) * 1000 || now),
      });
    }
    const ids = new Set(nodes.map((node) => node.id));
    edges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  } catch {
    return { nodes: [], edges: [] };
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
  return { nodes, edges };
}

function collectLocalAgents(template = '', now = Date.now(), options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const captionService = options.captioner || captioner;
  const claude = scanClaude(now, template, homeDir, captionService);
  const codex = scanCodex(now, template, homeDir, captionService);
  return {
    nodes: [...claude.nodes, ...codex.nodes],
    edges: [...claude.edges, ...codex.edges],
    scannedAt: now,
  };
}

module.exports = { collectLocalAgents, codexExcerpt, oneLine };
