import { useState, useCallback, useEffect, useRef } from 'react';
import type { Note } from '../api';
import { api } from '../api';
import { connectRunsSocket } from '../socket';
import { Wrench, Sparkles, FileText, Link2, Tags, MessageSquare } from 'lucide-react';

interface ChatBlock {
  type: string;
  text?: string;
  name?: string;
  input?: any;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content?: string;
  blocks?: ChatBlock[];
  isStreaming?: boolean;
}

interface AIPanelProps {
  note: Note | null;
  vaultId: string | null;
  onSave?: () => Promise<any>;
  onClose: () => void;
}

function ToolUseView({ block }: { block: ChatBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-tool-use" style={{ marginTop: '0.5rem', marginBottom: '0.5rem', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
      <div 
        className="ai-tool-header" 
        onClick={() => setOpen(!open)}
        style={{ padding: '0.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}
      >
        <span><Wrench size={14} /></span>
        <span style={{ flex: 1, fontFamily: 'monospace' }}>Used: {block.name}</span>
        <span>{open ? '▼' : '▶'}</span>
      </div>
      {open && block.input && (
        <pre style={{ margin: 0, padding: '0.5rem', fontSize: '0.75rem', overflowX: 'auto', borderTop: '1px solid var(--border-color)', background: 'var(--bg-tertiary)' }}>
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function AIPanel({ note, vaultId, onSave, onClose }: AIPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'completed' | 'failed'>('idle');
  const [runningTool, setRunningTool] = useState<string | null>(null);

  const socketRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  // Scroll to bottom on messages/runningTool update
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, runningTool]);

  // Connect socket and register listeners for run events
  const connectAndListenToRun = useCallback((runId: number, existingBlocks: ChatBlock[]) => {
    if (socketRef.current) {
      socketRef.current.disconnect();
    }

    const socket = connectRunsSocket();
    socketRef.current = socket;

    socket.emit('joinRun', runId);

    const aiMsgId = `ai-stream-${runId}`;

    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant') {
        return prev.map((msg, i) => i === prev.length - 1 ? { ...msg, id: aiMsgId, isStreaming: true } : msg);
      } else {
        return [...prev, { id: aiMsgId, role: 'assistant', blocks: existingBlocks, content: existingBlocks.length === 0 ? 'Thinking...' : undefined, isStreaming: true }];
      }
    });

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
                  content: hasBlocks ? undefined : (payload.status === 'completed' ? 'Agent finished successfully.' : 'Agent failed.'),
                  isStreaming: false
                };
              }
              return msg;
            })
          );
          setRunningTool(null);
          socket.disconnect();
          socketRef.current = null;
        }
      } else if (event.type === 'text') {
        const payload = JSON.parse(event.payload_json);
        if (payload.message && payload.message.content) {
          const newBlocks = payload.message.content;
          
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === aiMsgId
                ? { ...msg, content: undefined, blocks: [...(msg.blocks || []), ...newBlocks] }
                : msg
            )
          );

          // Update last used tool if available
          const toolUses = newBlocks.filter((c: any) => c.type === 'tool_use');
          if (toolUses.length > 0) {
            setRunningTool(toolUses[toolUses.length - 1].name);
          }
        }
      }
    });
  }, []);

  // Fetch the full history of runs for this note context
  const loadLatestRunHistory = useCallback(async () => {
    if (!vaultId) return;
    try {
      const { runs } = await api<{ runs: any[] }>(`/api/vaults/${vaultId}/runs`);
      const relevantRuns = note
        ? runs.filter((r) => r.note_id === note.id).sort((a,b) => a.id - b.id)
        : runs.filter((r) => r.note_id === null).sort((a,b) => a.id - b.id);

      if (relevantRuns.length === 0) {
        setMessages([]);
        setStatus('idle');
        setRunningTool(null);
        return;
      }

      const latestRun = relevantRuns[relevantRuns.length - 1];
      setStatus(latestRun.status);

      const eventsMap = new Map<number, any[]>();
      await Promise.all(relevantRuns.map(async (r) => {
        try {
          const { events } = await api<{ events: any[] }>(`/api/runs/${r.id}/events`);
          eventsMap.set(r.id, events);
        } catch(e) {
          // ignore
        }
      }));

      const newMessages: ChatMessage[] = [];

      for (const r of relevantRuns) {
        newMessages.push({
          id: `user-init-${r.id}`,
          role: 'user',
          content: r.prompt,
        });

        const events = eventsMap.get(r.id) || [];
        let aiBlocks: ChatBlock[] = [];
        
        for (const ev of events) {
          const payload = JSON.parse(ev.payload_json);
          if (ev.type === 'follow_up') {
            if (aiBlocks.length > 0) {
              newMessages.push({
                id: `ai-msg-${r.id}-${ev.id}-pre`,
                role: 'assistant',
                blocks: aiBlocks,
              });
              aiBlocks = [];
            }
            newMessages.push({
              id: `user-msg-${ev.id}`,
              role: 'user',
              content: payload.message,
            });
          } else if (ev.type === 'text' && payload.message?.content) {
            aiBlocks = [...aiBlocks, ...payload.message.content];
          }
        }
        
        if (aiBlocks.length > 0) {
          newMessages.push({
            id: `ai-msg-${r.id}-final`,
            role: 'assistant',
            blocks: aiBlocks,
          });
        } else if (r.status === 'completed' || r.status === 'failed') {
          newMessages.push({
            id: `ai-msg-${r.id}-fallback`,
            role: 'assistant',
            content: r.summary || (r.status === 'completed' ? 'Task completed.' : 'Task failed.'),
          });
        }
      }

      setMessages(newMessages);

      // Reconnect and stream if the latest run is active
      if (latestRun.status === 'running' || latestRun.status === 'queued') {
        const lastMsg = newMessages[newMessages.length - 1];
        const existingBlocks = (lastMsg && lastMsg.role === 'assistant' && lastMsg.blocks) ? lastMsg.blocks : [];
        connectAndListenToRun(latestRun.id, existingBlocks);
      } else {
        setRunningTool(null);
      }
    } catch (err) {
      console.error('Error loading run history:', err);
    }
  }, [vaultId, note?.id, connectAndListenToRun]);

  // Load history when note/vault changes
  useEffect(() => {
    void loadLatestRunHistory();
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [note?.id, vaultId, loadLatestRunHistory]);

  // Handle sending user prompt
  const startRunSession = useCallback(async (promptText: string) => {
    if (!vaultId) return;

    try {
      // Auto-save active note if dirty
      if (note && onSave) {
        await onSave();
      }

      const userMsgId = `user-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: 'user', content: promptText },
      ]);
      setInput('');
      setStatus('queued');

      const aiMsgId = `ai-stream-new`;
      setMessages((prev) => [
        ...prev,
        { id: aiMsgId, role: 'assistant', content: 'Initializing agent session...', isStreaming: true },
      ]);

      const res = await api<{ run: { id: number; status: string } }>(`/api/vaults/${vaultId}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: promptText,
          note_id: note?.id || null,
        }),
      });

      setStatus(res.run.status as any);
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
  }, [vaultId, note, onSave, connectAndListenToRun, showToast]);

  const handleSend = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || status === 'running' || status === 'queued') return;
    void startRunSession(input.trim());
  }, [input, status, startRunSession]);

  const handleQuickAction = useCallback((action: string) => {
    if (!note) {
      showToast('Please open a note first');
      return;
    }
    if (status === 'running' || status === 'queued') {
      showToast('Agent is currently running');
      return;
    }

    let promptText = '';
    switch (action) {
      case 'Summarize':
        promptText = `Please read the note "${note.title}.md" and write a concise, bulleted summary of its contents in a neat card.`;
        break;
      case 'Expand':
        promptText = `Please read the note "${note.title}.md", write detailed additions extending the concepts, and write the expanded contents directly back to the note file.`;
        break;
      case 'Find Related':
        promptText = `Search the notes in the vault for other notes related to "${note.title}.md", and present them as a list of wikilinks with brief explanations of the relationships.`;
        break;
      case 'Suggest Tags':
        promptText = `Analyze the note "${note.title}.md" and suggest tags. If any recommended tags are not already present in the note, edit the file on disk to append them at the bottom in #tag format.`;
        break;
      default:
        return;
    }

    void startRunSession(promptText);
  }, [note, status, startRunSession, showToast]);

  const isBusy = status === 'running' || status === 'queued';

  return (
    <aside className="ai-panel" id="ai-panel" style={{ gridColumn: 3 }}>
      {/* Header */}
      <div className="ai-panel-header">
        <div className="ai-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="ai-sparkle"><Sparkles size={16} /></span>
          AI Assistant
        </div>
        <button
          id="ai-panel-close"
          className="btn-icon"
          onClick={onClose}
          title="Close AI panel"
        >
          ✕
        </button>
      </div>

      {/* Context indicator */}
      {note && (
        <div className="ai-context">
          <span className="context-dot" />
          <span className="truncate">Context: {note.title || 'Untitled'}</span>
        </div>
      )}

      {/* Quick actions */}
      <div className="ai-quick-actions">
        <button
          id="ai-summarize"
          className="ai-action-btn"
          disabled={!note || isBusy}
          onClick={() => handleQuickAction('Summarize')}
        >
          <span className="action-emoji"><Sparkles size={16} /></span>
          Summarize
        </button>
        <button
          id="ai-expand"
          className="ai-action-btn"
          disabled={!note || isBusy}
          onClick={() => handleQuickAction('Expand')}
        >
          <span className="action-emoji"><FileText size={16} /></span>
          Expand
        </button>
        <button
          id="ai-related"
          className="ai-action-btn"
          disabled={!note || isBusy}
          onClick={() => handleQuickAction('Find Related')}
        >
          <span className="action-emoji"><Link2 size={16} /></span>
          Find Related
        </button>
        <button
          id="ai-tags"
          className="ai-action-btn"
          disabled={!note || isBusy}
          onClick={() => handleQuickAction('Suggest Tags')}
        >
          <span className="action-emoji"><Tags size={16} /></span>
          Suggest Tags
        </button>
      </div>

      {/* Chat area */}
      <div className="ai-chat">
        {messages.length === 0 ? (
          <div className="ai-empty">
            <span className="ai-empty-icon"><MessageSquare size={32} /></span>
            <span>Ask anything about your notes...</span>
            <span className="text-xs text-tertiary">
              AI-powered writing assistant
            </span>
          </div>
        ) : (
          <div className="ai-messages" id="ai-messages">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`ai-message ${msg.role === 'user' ? 'user' : 'assistant'}`}
              >
                {msg.content && <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>}
                {msg.blocks && msg.blocks.map((block, i) => (
                  <div key={i}>
                    {block.type === 'text' && <div style={{ whiteSpace: 'pre-wrap' }}>{block.text}</div>}
                    {block.type === 'tool_use' && <ToolUseView block={block} />}
                  </div>
                ))}
              </div>
            ))}
            {runningTool && (
              <div className="ai-tool-log" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Wrench size={12} /> running <code>{runningTool}</code>...
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        )}

        {/* Input */}
        <form className="ai-input-wrap" onSubmit={handleSend}>
          <input
            id="ai-input"
            className="ai-input"
            value={input}
            disabled={!vaultId || isBusy}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isBusy ? "Agent is working..." : "Ask about your notes..."}
          />
          <button
            id="ai-send"
            className="ai-send-btn"
            type="submit"
            disabled={!input.trim() || !vaultId || isBusy}
          >
            {isBusy ? '...' : '↑'}
          </button>
        </form>
      </div>

      {/* Toast */}
      {toast && <div className="toast">{toast}</div>}
    </aside>
  );
}
