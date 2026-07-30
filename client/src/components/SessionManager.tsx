import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Bot, ExternalLink, RefreshCw, Send, Square, X } from 'lucide-react';
import { api, formatRelativeDate } from '../api';

export type ActiveSession = {
  id: number;
  vault_id: string;
  note_id: string | null;
  prompt: string;
  agent: string;
  conversation_id: string;
  status: 'queued' | 'running';
  started_at: string;
  model: string | null;
  message_id: string | null;
  channel_id: string | null;
  channel_title: string | null;
  author: string | null;
  registration_id: string | null;
  mention: string | null;
};

type RunEvent = {
  id: number;
  seq: number;
  type: string;
  payload_json: string;
  ts: string;
};

type Props = {
  open: boolean;
  vaultId: string | null;
  runnerOnline: boolean;
  onClose: () => void;
  onOpenChat: (channelId: string) => void;
  onCancel: (runId: number) => void;
  onInterrogate: (channelId: string, message: string) => void;
};

function eventSummary(event: RunEvent): string {
  try {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    for (const key of ['text', 'message', 'summary', 'command', 'tool']) {
      if (typeof payload[key] === 'string' && payload[key]) return String(payload[key]);
    }
    return JSON.stringify(payload);
  } catch {
    return event.payload_json;
  }
}

export function SessionManager({
  open,
  vaultId,
  runnerOnline,
  onClose,
  onOpenChat,
  onCancel,
  onInterrogate,
}: Props) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!open || !vaultId) return;
    try {
      const response = await api<{ sessions: ActiveSession[] }>(`/api/vaults/${vaultId}/active-sessions`);
      setSessions(response.sessions);
      setSelectedId((current) => (
        current != null && response.sessions.some((session) => session.id === current)
          ? current
          : response.sessions[0]?.id ?? null
      ));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sessions');
    }
  }, [open, vaultId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || selectedId == null) {
      setEvents([]);
      return;
    }
    let active = true;
    const load = async () => {
      try {
        const response = await api<{ events: RunEvent[] }>(`/api/runs/${selectedId}/events`);
        if (active) setEvents(response.events);
      } catch {
        if (active) setEvents([]);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1_500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [open, selectedId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? null,
    [sessions, selectedId],
  );

  if (!open) return null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected?.channel_id || !draft.trim()) return;
    const mention = selected.mention || selected.author || selected.agent;
    onInterrogate(selected.channel_id, `@${mention.replace(/^@/, '')} ${draft.trim()}`);
    setDraft('');
  };

  return (
    <div className="session-manager-backdrop" role="dialog" aria-modal="true" aria-label="AI session manager">
      <section className="session-manager">
        <header className="session-manager-header">
          <div>
            <span className={`session-manager-status ${runnerOnline ? 'online' : 'offline'}`} />
            <div>
              <h2>AI sessions</h2>
              <p>{sessions.length} running · desktop runner {runnerOnline ? 'online' : 'offline'}</p>
            </div>
          </div>
          <div className="session-manager-header-actions">
            <button type="button" className="btn-icon" onClick={() => void refresh()} title="Refresh sessions">
              <RefreshCw size={15} />
            </button>
            <button type="button" className="btn-icon" onClick={onClose} title="Close session manager">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="session-manager-body">
          <nav className="session-manager-list" aria-label="Running AI sessions">
            {error && <div className="session-manager-error">{error}</div>}
            {!error && sessions.length === 0 && (
              <div className="session-manager-empty">
                <Activity size={24} />
                <strong>No AI sessions running</strong>
                <span>Active agents will appear here automatically.</span>
              </div>
            )}
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                className={`session-manager-item${session.id === selectedId ? ' selected' : ''}`}
                onClick={() => setSelectedId(session.id)}
              >
                <Bot size={16} />
                <span>
                  <strong>{session.author || session.agent}</strong>
                  <small>
                    {session.channel_title ? `#${session.channel_title}` : 'note run'}
                    {' · '}
                    {formatRelativeDate(session.started_at)}
                  </small>
                </span>
                <i className={session.status} title={session.status} />
              </button>
            ))}
          </nav>

          <main className="session-manager-detail">
            {selected ? (
              <>
                <div className="session-manager-summary">
                  <div>
                    <span className="session-manager-eyebrow">Run {selected.id}</span>
                    <h3>{selected.author || selected.agent}</h3>
                    <p>{selected.model || 'default model'} · {selected.status}</p>
                  </div>
                  <div className="session-manager-actions">
                    {selected.channel_id && (
                      <button type="button" onClick={() => onOpenChat(selected.channel_id!)}>
                        <ExternalLink size={13} /> Open chat
                      </button>
                    )}
                    <button type="button" className="danger" onClick={() => onCancel(selected.id)}>
                      <Square size={11} fill="currentColor" /> Stop
                    </button>
                  </div>
                </div>
                <section className="session-manager-prompt">
                  <span>Current request</span>
                  <p>{selected.prompt}</p>
                </section>
                <section className="session-manager-trace">
                  <div className="session-manager-section-title">Live event trace</div>
                  {events.length === 0 ? (
                    <p className="session-manager-muted">Waiting for session output…</p>
                  ) : events.map((event) => (
                    <div className="session-manager-event" key={event.id}>
                      <span>{event.type}</span>
                      <pre>{eventSummary(event)}</pre>
                    </div>
                  ))}
                </section>
                {selected.channel_id ? (
                  <form className="session-manager-interrogate" onSubmit={submit}>
                    <input
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={`Ask @${(selected.mention || selected.author || selected.agent).replace(/^@/, '')}…`}
                    />
                    <button type="submit" disabled={!draft.trim()} title="Send follow-up">
                      <Send size={14} />
                    </button>
                  </form>
                ) : (
                  <p className="session-manager-muted">This is a note run. Open its note to continue the conversation.</p>
                )}
              </>
            ) : (
              <div className="session-manager-detail-empty">Select a running session to inspect it.</div>
            )}
          </main>
        </div>
      </section>
    </div>
  );
}
