import { useEffect, useMemo, useState } from 'react';
import { api, formatDate, type Run, type RunEvent, type Spec, type SpecThread } from '../api';
import { connectRunSocket } from '../socket';
import { DiffView } from './DiffView';

type Props = { spec: Spec | null; onSpecChanged: () => void };

export function AgentPanel({ spec, onSpecChanged }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [diff, setDiff] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [threads, setThreads] = useState<SpecThread[]>([]);
  const [threadDraft, setThreadDraft] = useState('');
  const [status, setStatus] = useState('');

  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? runs[0] ?? null,
    [activeRunId, runs],
  );

  useEffect(() => {
    setRuns([]);
    setEvents([]);
    setDiff('');
    setThreads([]);
    setActiveRunId(null);
    if (spec) {
      void loadRuns(spec.id);
      void loadThreads(spec.id);
    }
  }, [spec?.id]);

  useEffect(() => {
    if (!activeRun) return;
    void loadRunDetail(activeRun);
    const socket = connectRunSocket();
    socket.emit('join', activeRun.id);
    socket.on('event', (event) => {
      if (event.run_id !== activeRun.id) return;
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
      if (event.type === 'status') void refreshActiveRun(activeRun.id);
    });
    socket.on('status', (message) => {
      if (message.runId === activeRun.id) void refreshActiveRun(activeRun.id);
    });
    const timer = activeRun.status === 'queued' || activeRun.status === 'running'
      ? window.setInterval(() => {
        void refreshActiveRun(activeRun.id);
      }, 1800)
      : null;
    return () => {
      socket.emit('leave', activeRun.id);
      socket.disconnect();
      if (timer) window.clearInterval(timer);
    };
  }, [activeRun?.id, activeRun?.status]);

  async function loadRuns(specId: string) {
    const data = await api<{ runs: Run[] }>(`/api/specs/${specId}/runs`);
    setRuns(data.runs);
    setActiveRunId((current) => current ?? data.runs[0]?.id ?? null);
  }

  async function loadThreads(specId: string) {
    const data = await api<{ threads: SpecThread[] }>(`/api/specs/${specId}/threads`);
    setThreads(data.threads);
  }

  async function loadRunDetail(run: Run) {
    const eventData = await api<{ events: RunEvent[] }>(`/api/runs/${run.id}/events`);
    setEvents(eventData.events);
    if (run.status === 'awaiting_review') {
      const diffData = await api<{ diff: string }>(`/api/runs/${run.id}/diff`);
      setDiff(diffData.diff);
    } else {
      setDiff('');
    }
  }

  async function refreshActiveRun(runId: number) {
    const data = await api<{ run: Run }>(`/api/runs/${runId}`);
    setRuns((current) => current.map((run) => run.id === data.run.id ? data.run : run));
    await loadRunDetail(data.run);
    if (data.run.status !== 'queued' && data.run.status !== 'running') onSpecChanged();
  }

  async function startRun(kind: Run['kind'] = 'reconcile') {
    if (!spec) return;
    setStatus('');
    try {
      const data = await api<{ run: Run }>(`/api/specs/${spec.id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ kind }),
      });
      setRuns((current) => [data.run, ...current.filter((run) => run.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      onSpecChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not start run');
    }
  }

  async function review(action: 'merge' | 'discard') {
    if (!activeRun) return;
    setStatus('');
    try {
      const data = await api<{ run: Run }>(`/api/runs/${activeRun.id}/${action}`, { method: 'POST' });
      setRuns((current) => current.map((run) => run.id === data.run.id ? data.run : run));
      await loadRunDetail(data.run);
      onSpecChanged();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `${action} failed`);
    }
  }

  async function sendFollowUp(event: React.FormEvent) {
    event.preventDefault();
    if (!activeRun || !followUp.trim()) return;
    setStatus('');
    try {
      await api<{ event: RunEvent }>(`/api/runs/${activeRun.id}/message`, {
        method: 'POST',
        body: JSON.stringify({ message: followUp }),
      });
      setFollowUp('');
      await loadRunDetail(activeRun);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not send follow-up');
    }
  }

  async function createThread(event: React.FormEvent) {
    event.preventDefault();
    if (!spec || !threadDraft.trim()) return;
    const data = await api<{ thread: SpecThread }>(`/api/specs/${spec.id}/threads`, {
      method: 'POST',
      body: JSON.stringify({ content: threadDraft, anchor: spec.title }),
    });
    setThreadDraft('');
    setThreads((current) => [data.thread, ...current]);
  }

  async function updateThread(threadId: number, action: 'resolve' | 'dismiss') {
    const data = await api<{ thread: SpecThread }>(`/api/threads/${threadId}/${action}`, { method: 'POST' });
    setThreads((current) => current.map((thread) => thread.id === data.thread.id ? data.thread : thread));
  }

  return (
    <aside className="agent-panel">
      <header>
        <h2>Runs</h2>
        <div className="run-actions">
          <button disabled={!spec || runs.some((run) => run.status === 'queued' || run.status === 'running')} onClick={() => startRun('reconcile')}>Reconcile</button>
          <button disabled={!spec || runs.some((run) => run.status === 'queued' || run.status === 'running')} onClick={() => startRun('describe')}>Describe</button>
        </div>
      </header>

      {status && <div className="panel-error">{status}</div>}

      <section className="runs-panel">
        <div className="run-list">
          {runs.map((run) => (
            <button key={run.id} className={`run-row ${run.id === activeRun?.id ? 'active' : ''}`} onClick={() => setActiveRunId(run.id)}>
              <span>#{run.id} {run.kind}</span>
              <span className={`badge ${run.status}`}>{run.status}</span>
              <small>{formatDate(run.started_at)}</small>
            </button>
          ))}
          {runs.length === 0 && (
            <div className="run-empty">
              <strong>No runs yet</strong>
              <p>Reconcile creates a reviewable worktree branch for this spec.</p>
            </div>
          )}
        </div>

        {activeRun && (
          <section className="run-detail">
            <div className="run-meta">
              <strong>{activeRun.branch_name}</strong>
              <small>{activeRun.summary || activeRun.status}</small>
            </div>
            <RunFeed events={events} />
            {(activeRun.status === 'awaiting_review' || activeRun.status === 'failed') && (
              <div className="review-actions">
                {activeRun.status === 'awaiting_review' && <button onClick={() => review('merge')}>Merge</button>}
                <button className="danger" onClick={() => review('discard')}>Discard</button>
              </div>
            )}
            {activeRun.status === 'running' && (
              <form className="follow-up" onSubmit={sendFollowUp}>
                <input value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Follow-up instruction" />
                <button type="submit" disabled={!followUp.trim()}>Send</button>
              </form>
            )}
            {diff && <DiffView diff={diff} />}
          </section>
        )}
      </section>

      {spec && (
        <section className="threads-panel">
          <h3>Threads</h3>
          <form className="thread-form" onSubmit={createThread}>
            <input value={threadDraft} onChange={(event) => setThreadDraft(event.target.value)} placeholder="Question or assumption" />
            <button type="submit" disabled={!threadDraft.trim()}>Add</button>
          </form>
          <div className="thread-list">
            {threads.filter((thread) => thread.status === 'open').map((thread) => (
              <div key={thread.id} className="thread-row">
                <small>{thread.anchor || 'Spec'}</small>
                <p>{thread.messages.at(-1)?.content || 'No messages'}</p>
                <div>
                  <button onClick={() => updateThread(thread.id, 'resolve')}>Resolve</button>
                  <button className="danger" onClick={() => updateThread(thread.id, 'dismiss')}>Dismiss</button>
                </div>
              </div>
            ))}
            {threads.filter((thread) => thread.status === 'open').length === 0 && <div className="run-empty"><p>No open threads.</p></div>}
          </div>
        </section>
      )}
    </aside>
  );
}

function RunFeed({ events }: { events: RunEvent[] }) {
  if (events.length === 0) return <div className="run-empty"><p>No events yet.</p></div>;
  return (
    <div className="run-feed">
      {events.map((event) => (
        <div key={event.id} className={`event-line ${event.type}`}>
          <span>{event.type}</span>
          <p>{eventText(event)}</p>
        </div>
      ))}
    </div>
  );
}

function eventText(event: RunEvent) {
  const payload = parsePayload(event.payload_json);
  if (event.type === 'status' && payload.status) return asText(payload.summary) || asText(payload.status) || 'Status update';
  if (event.type === 'error') return asText(payload.message) || 'Run failed';
  if (event.type === 'worktree') return `${payload.branch || ''} ${payload.path || ''}`.trim();
  if (event.type === 'result') return asText(payload.result) || asText(payload.subtype) || 'Completed';
  if (event.type === 'text') return assistantText(payload) || 'Assistant update';
  return asText(payload.message) || asText(payload.subtype) || asText(payload.type) || JSON.stringify(payload).slice(0, 180);
}

function assistantText(payload: Record<string, unknown>) {
  return asText(payload.message);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => asText(item)).filter(Boolean).join(' ').trim();
  }
  if (!value || typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;

  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;

  const structuredContent = asText(record.content);
  if (structuredContent) return structuredContent;

  return [record.role, record.name, record.type]
    .map((item) => (typeof item === 'string' ? item : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
