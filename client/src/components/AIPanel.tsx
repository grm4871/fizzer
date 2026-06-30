import { memo, useState, useCallback, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Note } from '../api';
import { api } from '../api';
import { connectRunsSocket, connectVaultSocket } from '../socket';
import {
  Bot, FileText,
  Brain, FilePen, FilePlus, SquareTerminal, Search, Folder,
  ListTodo, Wrench, Globe, Check, CircleAlert, ChevronRight, SquarePen,
} from 'lucide-react';

type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

const AGENTS: { id: AgentId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
];

const CUSTOM_MODEL_VALUE = '__custom__';

const AGENT_MODEL_PRESETS: Record<AgentId, { id: string; label: string }[]> = {
  'claude-code': [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
  ],
  'codex': [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ],
  'grok': [
    { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
    { id: 'grok-build', label: 'Grok Build' },
  ],
  'antigravity': [
    { id: 'flash_lite', label: 'Gemini Flash Lite' },
    { id: 'flash', label: 'Gemini Flash' },
    { id: 'pro', label: 'Gemini Pro' },
  ],
  'copilot': [
    { id: 'auto', label: 'Auto' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  'hermes': [],
};

const REMOVED_MODEL_PRESET_IDS = new Set([
  'codex-flash',
  'codex-pro',
  'grok-2',
  'grok-beta',
  'gpt-4o',
  'claude-3.5-sonnet',
  'o1-mini',
]);

const isAgentId = (v: string): v is AgentId => AGENTS.some((a) => a.id === v);

// Which agents have a running/queued run for this note (their latest run).
function computeBusyAgents(runs: any[], noteId: string | null): Set<AgentId> {
  const relevant = runs
    .filter((r) => (noteId ? r.note_id === noteId : r.note_id === null))
    .sort((a, b) => a.id - b.id);
  const latestByAgent = new Map<string, any>();
  for (const r of relevant) latestByAgent.set(r.agent, r); // last write = latest
  const busy = new Set<AgentId>();
  for (const [ag, r] of latestByAgent) {
    if ((r.status === 'running' || r.status === 'queued') && isAgentId(ag)) busy.add(ag);
  }
  return busy;
}

interface ChatBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  // tool_use
  name?: string;
  input?: any;
  toolUseId?: string;
  // tool_result
  content?: any;
  isError?: boolean;
  // thinking
  durationMs?: number;
  redacted?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  blocks?: ChatBlock[];
  images?: string[];
  isStreaming?: boolean;
}

interface AIPanelProps {
  note: Note | null;
  vaultId: string | null;
  onSave?: () => Promise<any>;
  /** A directive prompt queued from the editor; runs once per distinct nonce. */
  pendingPrompt?: { text: string; nonce: number } | null;
  onPromptConsumed?: () => void;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers: normalize SDK content blocks into our flat ChatBlock model
// ---------------------------------------------------------------------------

function normalizeContentBlocks(content: any): ChatBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ChatBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    switch (c.type) {
      case 'text':
        if (c.text) out.push({ type: 'text', text: c.text });
        break;
      case 'thinking':
        out.push({ type: 'thinking', text: c.thinking || c.text || '' });
        break;
      case 'redacted_thinking':
        out.push({ type: 'thinking', text: '', redacted: true });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', name: c.name, input: c.input, toolUseId: c.id });
        break;
      case 'tool_result':
        out.push({ type: 'tool_result', toolUseId: c.tool_use_id, content: c.content, isError: c.is_error });
        break;
    }
  }
  return out;
}

function stringifyResult(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content, null, 2);
}

function basename(p?: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return '<1s';
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

// Friendly label + icon for a tool call, mirroring opencode / Claude Code style.
function describeTool(name?: string, input?: any): { icon: ReactNode; verb: string; target: string } {
  const i = input || {};
  switch (name) {
    case 'Read':
      return { icon: <FileText size={13} />, verb: 'Read', target: basename(i.file_path) };
    case 'Write':
      return { icon: <FilePlus size={13} />, verb: 'Wrote', target: basename(i.file_path) };
    case 'Edit':
    case 'MultiEdit':
      return { icon: <FilePen size={13} />, verb: 'Edited', target: basename(i.file_path) };
    case 'Bash':
      return { icon: <SquareTerminal size={13} />, verb: 'Ran', target: truncate(i.command || '', 52) };
    case 'Grep':
      return { icon: <Search size={13} />, verb: 'Searched', target: truncate(i.pattern || '', 40) };
    case 'Glob':
      return { icon: <Search size={13} />, verb: 'Globbed', target: truncate(i.pattern || '', 40) };
    case 'LS':
      return { icon: <Folder size={13} />, verb: 'Listed', target: basename(i.path) || '.' };
    case 'TodoWrite':
      return { icon: <ListTodo size={13} />, verb: 'Updated plan', target: '' };
    case 'WebFetch':
      return { icon: <Globe size={13} />, verb: 'Fetched', target: truncate(i.url || '', 40) };
    case 'WebSearch':
      return { icon: <Globe size={13} />, verb: 'Searched web', target: truncate(i.query || '', 40) };
    default:
      return { icon: <Wrench size={13} />, verb: name || 'Tool', target: '' };
  }
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ThinkingView({ block }: { block: ChatBlock }) {
  const [open, setOpen] = useState(false);
  const dur = formatDuration(block.durationMs);
  const label = block.redacted
    ? 'Thought (redacted)'
    : dur ? `Thought for ${dur}` : 'Thought process';
  const expandable = !block.redacted && !!block.text;
  return (
    <div className={`ai-thinking ${open ? 'open' : ''}`}>
      <div
        className="ai-thinking-header"
        onClick={() => expandable && setOpen((o) => !o)}
        style={{ cursor: expandable ? 'pointer' : 'default' }}
      >
        <Brain size={13} />
        <span className="ai-thinking-label">{label}</span>
        {expandable && <ChevronRight size={13} className="ai-chevron" />}
      </div>
      {open && expandable && <div className="ai-thinking-body">{block.text}</div>}
    </div>
  );
}

function ToolView({ block, result }: { block: ChatBlock; result?: ChatBlock }) {
  const [open, setOpen] = useState(false);
  const { icon, verb, target } = describeTool(block.name, block.input);
  const status: 'running' | 'done' | 'error' = !result
    ? 'running'
    : result.isError ? 'error' : 'done';
  const resultText = result ? stringifyResult(result.content) : '';
  return (
    <div className={`ai-tool status-${status} ${open ? 'open' : ''}`}>
      <div className="ai-tool-header" onClick={() => setOpen((o) => !o)}>
        <span className="ai-tool-icon">{icon}</span>
        <span className="ai-tool-verb">{verb}</span>
        {target && <code className="ai-tool-target">{target}</code>}
        <span className="ai-tool-status">
          {status === 'running' && <span className="ai-spinner" />}
          {status === 'done' && <Check size={13} />}
          {status === 'error' && <CircleAlert size={13} />}
        </span>
        <ChevronRight size={13} className="ai-chevron" />
      </div>
      {open && (
        <div className="ai-tool-detail">
          {block.input && Object.keys(block.input).length > 0 && (
            <pre className="ai-tool-input">{JSON.stringify(block.input, null, 2)}</pre>
          )}
          {result && (
            <pre className={`ai-tool-output ${result.isError ? 'is-error' : ''}`}>
              {truncate(resultText, 4000) || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

const MessageBlocks = memo(function MessageBlocks({ msg }: { msg: ChatMessage }) {
  // Build a lookup of tool results by tool_use id so each tool card can show its output.
  const resultMap = new Map<string, ChatBlock>();
  for (const b of msg.blocks || []) {
    if (b.type === 'tool_result' && b.toolUseId) resultMap.set(b.toolUseId, b);
  }
  return (
    <>
      {msg.content && (
        <div className="ai-markdown">
          <ReactMarkdown>{msg.content}</ReactMarkdown>
        </div>
      )}
      {(msg.blocks || []).map((block, i) => {
        if (block.type === 'tool_result') return null; // rendered inside its tool card
        if (block.type === 'text') {
          return (
            <div key={i} className="ai-markdown">
              <ReactMarkdown>{block.text || ''}</ReactMarkdown>
            </div>
          );
        }
        if (block.type === 'thinking') return <ThinkingView key={i} block={block} />;
        if (block.type === 'tool_use') {
          return (
            <ToolView
              key={i}
              block={block}
              result={block.toolUseId ? resultMap.get(block.toolUseId) : undefined}
            />
          );
        }
        return null;
      })}
    </>
  );
});

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function AIPanel({ note, vaultId, onSave, pendingPrompt, onPromptConsumed, onClose }: AIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'completed' | 'failed'>('idle');
  const [agent, setAgent] = useState<AgentId>('claude-code');
  const [modelChoice, setModelChoice] = useState<string>('');
  const [customModel, setCustomModel] = useState<string>('');
  const [historyReady, setHistoryReady] = useState(false);
  // Current conversation thread (null = start a fresh one on the next run).
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Pasted images staged for the next message.
  const [pendingImages, setPendingImages] = useState<{ media_type: string; data: string; url: string }[]>([]);
  // Agents with a running/queued run for this note (for the activity dot).
  const [busyAgents, setBusyAgents] = useState<Set<AgentId>>(new Set());
  const [currentRunId, setCurrentRunId] = useState<number | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState(0);
  const processedNonceRef = useRef<number | null>(null);
  // Tracks the last note we loaded, to restore its last-used agent on open.
  const lastNoteRef = useRef<string | null | undefined>(undefined);

  const socketRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // Timestamp used to estimate how long the model "thought" before each message.
  const turnStartRef = useRef<number>(Date.now());

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  const applyModelSelection = useCallback((agentId: AgentId, model?: string | null) => {
    const trimmed = model?.trim();
    if (!trimmed) {
      setModelChoice('');
      setCustomModel('');
      return;
    }
    if (REMOVED_MODEL_PRESET_IDS.has(trimmed)) {
      setModelChoice('');
      setCustomModel('');
      return;
    }

    const presets = AGENT_MODEL_PRESETS[agentId];
    if (presets.some((preset) => preset.id === trimmed)) {
      setModelChoice(trimmed);
      setCustomModel('');
    } else {
      setModelChoice(CUSTOM_MODEL_VALUE);
      setCustomModel(trimmed);
    }
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Connect socket and register listeners for run events
  const connectAndListenToRun = useCallback((runId: number, existingBlocks: ChatBlock[]) => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = connectRunsSocket();
    socketRef.current = socket;
    socket.emit('joinRun', runId);

    const aiMsgId = `ai-stream-${runId}`;
    turnStartRef.current = Date.now();

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        return prev.map((msg, i) => i === prev.length - 1 ? { ...msg, id: aiMsgId, isStreaming: true } : msg);
      }
      return [...prev, { id: aiMsgId, role: 'assistant', blocks: existingBlocks, content: existingBlocks.length === 0 ? 'Thinking…' : undefined, isStreaming: true }];
    });

    const appendBlocks = (blocks: ChatBlock[]) => {
      if (blocks.length === 0) return;
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== aiMsgId) return msg;
          
          const newBlocks = [...(msg.blocks || [])];
          for (const b of blocks) {
            const last = newBlocks[newBlocks.length - 1];
            if (last && last.type === b.type && (b.type === 'text' || b.type === 'thinking')) {
              newBlocks[newBlocks.length - 1] = {
                ...last,
                text: (last.text || '') + (b.text || ''),
              };
            } else {
              newBlocks.push({ ...b });
            }
          }
          return { ...msg, content: undefined, blocks: newBlocks };
        })
      );
    };

    socket.on('event', (event: any) => {
      if (event.type === 'status') {
        const payload = JSON.parse(event.payload_json);
        setStatus(payload.status);
        if (payload.status === 'completed' || payload.status === 'failed') {
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === aiMsgId) {
                const hasBlocks = msg.blocks && msg.blocks.length > 0;
                return {
                  ...msg,
                  content: hasBlocks ? undefined : (payload.status === 'completed' ? 'Done.' : 'Agent failed.'),
                  isStreaming: false,
                };
              }
              return msg;
            })
          );
          socket.disconnect();
          socketRef.current = null;
        }
      } else if (event.type === 'text') {
        const payload = JSON.parse(event.payload_json);
        if (payload.message?.content) {
          const blocks = normalizeContentBlocks(payload.message.content);
          const now = Date.now();
          for (const b of blocks) {
            if (b.type === 'thinking') b.durationMs = now - turnStartRef.current;
          }
          turnStartRef.current = now;
          appendBlocks(blocks);
        }
      } else if (event.type === 'user') {
        // Tool results come back as user messages with tool_result content.
        const payload = JSON.parse(event.payload_json);
        const results = normalizeContentBlocks(payload.message?.content).filter((b) => b.type === 'tool_result');
        turnStartRef.current = Date.now();
        appendBlocks(results);
      }
    });
  }, []);

  // Parse SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) timestamps
  const parseTs = (ts?: string): number => {
    if (!ts) return 0;
    const v = Date.parse(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
    return Number.isNaN(v) ? 0 : v;
  };

  // Fetch the full history of runs for this note context
  const loadLatestRunHistory = useCallback(async () => {
    if (!vaultId) return;
    try {
      const { runs } = await api<{ runs: any[] }>(`/api/vaults/${vaultId}/runs`);
      setBusyAgents(computeBusyAgents(runs, note?.id ?? null));
      const noteRuns = (note
        ? runs.filter((r) => r.note_id === note.id)
        : runs.filter((r) => r.note_id === null)
      ).sort((a, b) => a.id - b.id);

      // On opening a different note, restore the agent it was last used with.
      const noteKey = note?.id ?? null;
      let viewAgent = agent;
      if (lastNoteRef.current !== noteKey) {
        lastNoteRef.current = noteKey;
        const lastRun = noteRuns[noteRuns.length - 1];
        if (lastRun && isAgentId(lastRun.agent)) {
          viewAgent = lastRun.agent;
          if (viewAgent !== agent) setAgent(viewAgent); // reloads via the agent dep
        }
      }

      // Each agent has its own thread; show only the latest conversation in it.
      const agentRuns = noteRuns.filter((r) => r.agent === viewAgent);
      const latestConversation = agentRuns.length ? agentRuns[agentRuns.length - 1].conversation_id : null;
      setConversationId(latestConversation);
      const relevantRuns = agentRuns.filter((r) => r.conversation_id === latestConversation);

      if (relevantRuns.length === 0) {
        setMessages([]);
        setStatus('idle');
        applyModelSelection(viewAgent, null);
        return;
      }

      const latestRun = relevantRuns[relevantRuns.length - 1];
      setStatus(latestRun.status);
      setCurrentRunId(latestRun.id);
      applyModelSelection(viewAgent, latestRun.model);

      const eventsMap = new Map<number, any[]>();
      await Promise.all(relevantRuns.map(async (r) => {
        try {
          const { events } = await api<{ events: any[] }>(`/api/runs/${r.id}/events`);
          eventsMap.set(r.id, events);
        } catch { /* ignore */ }
      }));

      const newMessages: ChatMessage[] = [];

      for (const r of relevantRuns) {
        newMessages.push({ id: `user-init-${r.id}`, role: 'user', content: r.prompt });

        const events = eventsMap.get(r.id) || [];
        let aiBlocks: ChatBlock[] = [];
        let prevTs = parseTs(r.started_at) || (events.length ? parseTs(events[0].ts) : 0);

        const flush = (idSuffix: string) => {
          if (aiBlocks.length > 0) {
            newMessages.push({ id: `ai-msg-${r.id}-${idSuffix}`, role: 'assistant', blocks: aiBlocks });
            aiBlocks = [];
          }
        };

        for (const ev of events) {
          const payload = JSON.parse(ev.payload_json);
          const ts = parseTs(ev.ts);
          if (ev.type === 'follow_up') {
            flush(`pre-${ev.id}`);
            newMessages.push({ id: `user-msg-${ev.id}`, role: 'user', content: payload.message });
          } else if (ev.type === 'text' && payload.message?.content) {
            const blocks = normalizeContentBlocks(payload.message.content);
            for (const b of blocks) {
              if (b.type === 'thinking' && ts && prevTs) b.durationMs = ts - prevTs;
              
              const last = aiBlocks[aiBlocks.length - 1];
              if (last && last.type === b.type && (b.type === 'text' || b.type === 'thinking')) {
                aiBlocks[aiBlocks.length - 1] = {
                  ...last,
                  text: (last.text || '') + (b.text || ''),
                };
              } else {
                aiBlocks.push({ ...b });
              }
            }
          } else if (ev.type === 'user' && payload.message?.content) {
            const results = normalizeContentBlocks(payload.message.content).filter((b) => b.type === 'tool_result');
            aiBlocks = [...aiBlocks, ...results];
          }
          if (ts) prevTs = ts;
        }

        if (aiBlocks.length > 0) {
          flush('final');
        } else if (r.status === 'completed' || r.status === 'failed') {
          newMessages.push({
            id: `ai-msg-${r.id}-fallback`,
            role: 'assistant',
            content: r.summary || (r.status === 'completed' ? 'Task completed.' : 'Task failed.'),
          });
        }
      }

      setMessages(newMessages);

      if (latestRun.status === 'running' || latestRun.status === 'queued') {
        const lastMsg = newMessages[newMessages.length - 1];
        const existingBlocks = (lastMsg && lastMsg.role === 'assistant' && lastMsg.blocks) ? lastMsg.blocks : [];
        connectAndListenToRun(latestRun.id, existingBlocks);
      }
    } catch (err) {
      console.error('Error loading run history:', err);
    }
  }, [vaultId, note?.id, agent, connectAndListenToRun, applyModelSelection]);

  useEffect(() => {
    setHistoryReady(false);
    void loadLatestRunHistory().finally(() => setHistoryReady(true));
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [note?.id, vaultId, loadLatestRunHistory]);

  // Keep the per-agent activity dots fresh: runs emit vault:noteChanged on
  // completion, so re-derive busy agents whenever the vault signals a change.
  useEffect(() => {
    if (!vaultId) return;
    const socket = connectVaultSocket();
    socket.emit('joinVault', vaultId);
    const refresh = async () => {
      try {
        const { runs } = await api<{ runs: any[] }>(`/api/vaults/${vaultId}/runs`);
        setBusyAgents(computeBusyAgents(runs, note?.id ?? null));
      } catch { /* ignore */ }
    };
    socket.on('vault:noteChanged', refresh);
    return () => {
      socket.off('vault:noteChanged', refresh);
      socket.emit('leaveVault', vaultId);
      socket.disconnect();
    };
  }, [vaultId, note?.id]);

  // Handle sending user prompt
  const startRunSession = useCallback(async (promptText: string, images: { media_type: string; data: string; url: string }[] = []) => {
    if (!vaultId) return;
    try {
      if (note && onSave) {
        await onSave();
      }

      const userMsgId = `user-${Date.now()}`;
      setMessages((prev) => [...prev, { id: userMsgId, role: 'user', content: promptText, images: images.map((i) => i.url) }]);
      setInput('');
      setStatus('queued');
      setBusyAgents((prev) => new Set(prev).add(agent));

      const aiMsgId = `ai-stream-new`;
      setMessages((prev) => [...prev, { id: aiMsgId, role: 'assistant', content: 'Thinking…', isStreaming: true }]);

      const res = await api<{ run: { id: number; status: string; conversation_id: string } }>(`/api/vaults/${vaultId}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: promptText,
          note_id: note?.id || null,
          agent,
          conversation_id: conversationId,
          images: images.map(({ media_type, data }) => ({ media_type, data })),
          model: (modelChoice === CUSTOM_MODEL_VALUE ? customModel.trim() : modelChoice) || undefined,
        }),
      });

      if (res.run.conversation_id) setConversationId(res.run.conversation_id);
      setStatus(res.run.status as any);
      setCurrentRunId(res.run.id);
      connectAndListenToRun(res.run.id, []);
    } catch (err) {
      console.error('Failed to start agent run:', err);
      showToast(err instanceof Error ? err.message : 'Error starting agent run');
      setStatus('failed');
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id.startsWith('ai-stream')
            ? { ...msg, content: 'Failed to initialize agent session.', isStreaming: false }
            : msg
        )
      );
    }
  }, [vaultId, note, onSave, connectAndListenToRun, showToast, agent, conversationId, modelChoice, customModel]);

  // Run a directive queued from the editor — once history has loaded so it
  // doesn't get clobbered, and once per distinct nonce.
  useEffect(() => {
    if (!pendingPrompt || !historyReady) return;
    if (processedNonceRef.current === pendingPrompt.nonce) return;
    processedNonceRef.current = pendingPrompt.nonce;
    if (vaultId && status !== 'running' && status !== 'queued') {
      void startRunSession(pendingPrompt.text);
    } else if (status === 'running' || status === 'queued') {
      showToast('Agent is currently running');
    }
    onPromptConsumed?.();
  }, [pendingPrompt, historyReady, vaultId, status, startRunSession, onPromptConsumed, showToast]);

  const handleCancel = useCallback(async () => {
    if (!currentRunId) return;
    try {
      await api(`/api/runs/${currentRunId}/cancel`, { method: 'POST' });
      showToast('Cancellation requested');
    } catch (err) {
      showToast('Failed to cancel run');
      console.error(err);
    }
  }, [currentRunId, showToast]);

  const handleCancelForm = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    void handleCancel();
  }, [handleCancel]);

  const handleSend = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && pendingImages.length === 0) || status === 'running' || status === 'queued') return;
    if (pendingImages.length > 0 && (agent === 'grok' || agent === 'antigravity' || agent === 'copilot' || agent === 'hermes')) {
      const name = agent === 'grok' ? 'Grok' : agent === 'antigravity' ? 'Antigravity' : agent === 'copilot' ? 'Copilot' : 'Hermes';
      showToast(`${name} has no image support — sending text only.`);
    }
    void startRunSession(input.trim(), pendingImages);
    setPendingImages([]);
  }, [input, pendingImages, status, startRunSession, agent, showToast]);

  // Start a fresh conversation thread for the current note + agent.
  const handleNewChat = useCallback(() => {
    if (socketRef.current) { socketRef.current.disconnect(); socketRef.current = null; }
    setMessages([]);
    setConversationId(null);
    setStatus('idle');
    setPendingImages([]);
  }, []);

  // Capture images pasted into the input.
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const data = url.split(',')[1] || '';
        setPendingImages((prev) => [...prev, { media_type: file.type, data, url }].slice(0, 8));
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const isBusy = status === 'running' || status === 'queued';

  useEffect(() => {
    let timer: any;
    if (isBusy) {
      const startTime = Date.now();
      setWorkingSeconds(0);
      timer = setInterval(() => {
        setWorkingSeconds(Math.round((Date.now() - startTime) / 1000));
      }, 1000);
    } else {
      setWorkingSeconds(0);
    }
    return () => clearInterval(timer);
  }, [isBusy]);

  return (
    <aside className="ai-panel" id="ai-panel" style={{ gridColumn: 3 }}>
      {/* Header */}
      <div className="ai-panel-header">
        <div className="ai-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="ai-sparkle"><Bot size={16} /></span>
          Agent
          {isBusy && (
            <span className="ai-status-pill">
              {status === 'queued' ? 'queued' : 'working'}
              {workingSeconds > 0 && ` (${workingSeconds}s)`}
            </span>
          )}
          {isBusy && (
            <button
              id="ai-cancel-header"
              type="button"
              onClick={handleCancel}
              title="Cancel run"
              style={{
                fontSize: '0.75rem',
                padding: '2px 6px',
                color: 'var(--danger)',
                background: 'var(--danger-subtle)',
                border: '1px solid hsla(5, 62%, 58%, 0.2)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                marginLeft: '6px'
              }}
            >
              Cancel
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button
            id="ai-new-chat"
            className="btn-icon"
            onClick={handleNewChat}
            disabled={messages.length === 0 || isBusy}
            title="New chat"
          >
            <SquarePen size={15} />
          </button>
          <button id="ai-panel-close" className="btn-icon" onClick={onClose} title="Close AI panel">✕</button>
        </div>
      </div>

      {/* Context indicator */}
      {note && (
        <div className="ai-context">
          <span className="context-dot" />
          <span className="truncate">Context: {note.title || 'Untitled'}</span>
        </div>
      )}

      {/* Agent selector */}
      <div className="ai-agent-selector" role="radiogroup" aria-label="Agent">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={agent === a.id}
            className={`ai-agent-btn ${agent === a.id ? 'active' : ''}`}
            onClick={() => {
              setAgent(a.id);
              applyModelSelection(a.id, null);
            }}
          >
            {a.label}
            {busyAgents.has(a.id) && <span className="ai-agent-dot" title="Working…" />}
          </button>
        ))}
      </div>

      {/* Model selector */}
      <div className="ai-model-selector">
        <label htmlFor="ai-model-select">Model</label>
        <select
          id="ai-model-select"
          className="ai-model-select"
          value={modelChoice}
          disabled={isBusy}
          onChange={(e) => {
            setModelChoice(e.target.value);
            if (e.target.value !== CUSTOM_MODEL_VALUE) setCustomModel('');
          }}
        >
          <option value="">Agent default</option>
          {AGENT_MODEL_PRESETS[agent].map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
          <option value={CUSTOM_MODEL_VALUE}>Custom model ID…</option>
        </select>
        {modelChoice === CUSTOM_MODEL_VALUE && (
          <input
            className="ai-model-input"
            value={customModel}
            disabled={isBusy}
            spellCheck={false}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="model id"
          />
        )}
      </div>

      {/* Chat area */}
      <div className="ai-chat">
        <div className="ai-messages" id="ai-messages">
          {messages.map((msg) => (
              <div key={msg.id} className={`ai-message ${msg.role === 'user' ? 'user' : 'assistant'}`}>
                {msg.role === 'user'
                  ? <>
                      {msg.images && msg.images.length > 0 && (
                        <div className="ai-msg-images">
                          {msg.images.map((src, i) => <img key={i} src={src} alt="" className="ai-msg-image" />)}
                        </div>
                      )}
                      {msg.content && <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>}
                    </>
                  : <MessageBlocks msg={msg} />}
                {msg.isStreaming && (
                  <div className="ai-typing"><span /><span /><span /></div>
                )}
              </div>
            ))}
            <div ref={chatEndRef} />
        </div>

        {/* Pasted image previews */}
        {pendingImages.length > 0 && (
          <div className="ai-paste-previews">
            {pendingImages.map((img, i) => (
              <div key={i} className="ai-paste-thumb">
                <img src={img.url} alt="" />
                <button
                  type="button"
                  className="ai-paste-remove"
                  title="Remove image"
                  onClick={() => setPendingImages((prev) => prev.filter((_, j) => j !== i))}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        {/* Input */}
        <form className="ai-input-wrap" onSubmit={isBusy ? handleCancelForm : handleSend}>
          <input
            id="ai-input"
            className="ai-input"
            value={input}
            disabled={!vaultId || isBusy}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            placeholder={isBusy ? 'Agent is working…' : ''}
          />
          <button
            id="ai-send"
            className={`ai-send-btn ${isBusy ? 'is-busy' : ''}`}
            type="submit"
            disabled={!isBusy && ((!input.trim() && pendingImages.length === 0) || !vaultId)}
            style={isBusy ? {
              color: 'var(--danger)',
              background: 'var(--danger-subtle)',
              border: '1px solid hsla(5, 62%, 58%, 0.2)',
              cursor: 'pointer'
            } : undefined}
          >
            {isBusy ? '■' : '↑'}
          </button>
        </form>
      </div>

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </aside>
  );
}
