import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Bot, EyeOff, Flag, Loader2, Maximize2, MessageCircle, Minimize2, Send, Square, X } from 'lucide-react';
import { ChatMessageText } from './ChatMarkdown';
import type { DesktopRunnerHealth } from '../chat/types';
import {
  buildDocumentationPrompt,
  documentationErrorMessage,
  startDocumentationRun,
  type DocumentationAssistantTurn,
  type DocumentationRunStatus,
} from '../documentationAssistant';
import guideMarkdown from '../../../docs/user-guide.md?raw';

export interface DocumentationAssistantProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  vaultId: string | null;
  runnerHealth: DesktopRunnerHealth | null;
  onReportFeedback: (body: string) => Promise<void>;
}

export function DocumentationAssistant({
  open,
  onOpen,
  onClose,
  vaultId,
  runnerHealth,
  onReportFeedback,
}: DocumentationAssistantProps) {
  const launcherRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const [turns, setTurns] = useState<DocumentationAssistantTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<DocumentationRunStatus>('completed');
  const [error, setError] = useState('');
  const [activeRun, setActiveRun] = useState<{ cancel: () => Promise<void> } | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState('');
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [feedbackError, setFeedbackError] = useState('');
  const [view, setView] = useState<'ask' | 'guide'>('ask');
  const [expanded, setExpanded] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(true);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => questionRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const close = useCallback(() => {
    onClose();
    setExpanded(false);
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }, [onClose]);

  const hideLauncher = useCallback(() => {
    onClose();
    setExpanded(false);
    setLauncherVisible(false);
  }, [onClose]);

  const submit = useCallback(async () => {
    const question = draft.trim();
    if (!question || activeRun || !vaultId) return;
    setDraft('');
    setError('');
    setStatus('queued');
    const userTurn: DocumentationAssistantTurn = {
      id: `guide-user-${Date.now()}`,
      role: 'user',
      body: question,
      status: 'completed',
    };
    const assistantTurn: DocumentationAssistantTurn = {
      id: `guide-assistant-${Date.now()}`,
      role: 'assistant',
      body: '',
      status: 'streaming',
    };
    const priorTurns = turns;
    setTurns((current) => [...current, userTurn, assistantTurn]);

    try {
      const run = await startDocumentationRun({
        vaultId,
        prompt: buildDocumentationPrompt(guideMarkdown, question, priorTurns),
        onAnswer: (answer) => setTurns((current) => current.map((turn) => (
          turn.id === assistantTurn.id ? { ...turn, body: answer } : turn
        ))),
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (nextStatus === 'completed' || nextStatus === 'failed' || nextStatus === 'canceled') {
            setActiveRun(null);
          }
          if (nextStatus === 'failed') setError(detail || 'Codex could not answer this question.');
          if (nextStatus === 'canceled') setError(detail || 'Canceled by you.');
          if (nextStatus === 'completed') {
            setTurns((current) => current.map((turn) => (
              turn.id === assistantTurn.id
                ? { ...turn, status: 'completed', body: turn.body || detail || 'The guide returned no answer.' }
                : turn
            )));
          }
          if (nextStatus === 'failed' || nextStatus === 'canceled') {
            setTurns((current) => current.map((turn) => (
              turn.id === assistantTurn.id
                ? { ...turn, status: nextStatus, body: turn.body || detail || (nextStatus === 'canceled' ? 'Canceled by you.' : 'Codex could not answer this question.') }
                : turn
            )));
          }
        },
      });
      setActiveRun(run);
    } catch (runError) {
      const message = documentationErrorMessage(runError);
      setError(message);
      setStatus('failed');
      setTurns((current) => current.map((turn) => (
      turn.id === assistantTurn.id ? { ...turn, status: 'failed', body: message } : turn
      )));
    }
  }, [activeRun, draft, turns, vaultId]);

  const stop = useCallback(async () => {
    if (!activeRun) return;
    await activeRun.cancel();
    setActiveRun(null);
    setStatus('canceled');
  }, [activeRun]);

  const sendFeedback = useCallback(async () => {
    const body = feedbackDraft.trim();
    if (!body || feedbackState === 'sending') return;
    setFeedbackState('sending');
    setFeedbackError('');
    try {
      await onReportFeedback(body);
      setFeedbackDraft('');
      setFeedbackState('sent');
    } catch (feedbackFailure) {
      setFeedbackState('error');
      setFeedbackError(feedbackFailure instanceof Error ? feedbackFailure.message : 'Could not send feedback.');
    }
  }, [feedbackDraft, feedbackState, onReportFeedback]);

  return (
    <>
      {launcherVisible && <button
        ref={launcherRef}
        type="button"
        className="documentation-assistant-launcher"
        onClick={open ? close : onOpen}
        aria-label="Ask the Fizzer guide"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="fizzer-guide-dialog"
        title="Ask the Fizzer guide"
      >
        {open ? <X size={18} /> : <Bot size={18} />}
      </button>}

      <aside
        id="fizzer-guide-dialog"
        className={`documentation-assistant${open ? ' is-open' : ''}${expanded ? ' is-expanded' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="fizzer-guide-title"
        data-run-status={status}
        hidden={!open}
      >
        <header className="documentation-assistant-header">
          <div>
            <span className="surface-kicker">In-app help</span>
            <h2 id="fizzer-guide-title">Ask the Fizzer guide</h2>
            <p>Read the full guide here, or ask questions with a connected runner.</p>
          </div>
          <div className="documentation-assistant-header-actions">
            <button
              type="button"
              className="btn-icon"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? 'Exit full screen' : 'View guide full screen'}
              title={expanded ? 'Exit full screen' : 'Full screen'}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" className="btn-icon" onClick={close} aria-label="Close guide"><X size={16} /></button>
          </div>
        </header>

        <nav className="documentation-assistant-tabs" aria-label="Guide options">
          <button type="button" className={view === 'ask' ? 'is-active' : ''} onClick={() => setView('ask')}><MessageCircle size={14} /> Ask</button>
          <button type="button" className={view === 'guide' ? 'is-active' : ''} onClick={() => setView('guide')}><BookOpen size={14} /> Read guide</button>
          <button type="button" className="documentation-assistant-hide-launcher" onClick={hideLauncher}><EyeOff size={14} /> Hide help button</button>
        </nav>

        <div className="documentation-assistant-body">
          {view === 'guide' ? (
            <article className="documentation-assistant-guide">
              <ChatMessageText messageId="fizzer-user-guide" body={guideMarkdown} mentionableAliases={[]} />
            </article>
          ) : turns.length === 0 && (
            <div className="documentation-assistant-empty">
              <MessageCircle size={22} />
              <strong>What would you like to do?</strong>
              <span>Ask why a feature exists, where to find it, or how to use it.</span>
              <button type="button" onClick={() => setView('guide')}><BookOpen size={14} /> Browse the guide without an AI runner</button>
            </div>
          )}
          {view === 'ask' && turns.map((turn) => (
            <article className={`documentation-assistant-turn is-${turn.role}`} key={turn.id}>
              <span className="documentation-assistant-turn-label">{turn.role === 'user' ? 'You' : 'Fizzer guide'}</span>
              {turn.body ? (
                turn.role === 'assistant' ? (
                  <ChatMessageText messageId={turn.id} body={turn.body} isAgent mentionableAliases={[]} />
                ) : <p>{turn.body}</p>
              ) : <span className="documentation-assistant-thinking"><Loader2 size={14} className="is-spinning" /> Thinking…</span>}
            </article>
          ))}
          {view === 'ask' && runnerHealth?.online === false && (
            <p className="documentation-assistant-notice">Questions need a connected runner. You can still read the complete guide above.</p>
          )}
          {view === 'ask' && error && <p className="documentation-assistant-error" role="alert">{error}</p>}
        </div>

        {view === 'ask' && <footer className="documentation-assistant-footer">
          {feedbackOpen ? (
            <div className="documentation-assistant-feedback">
              <strong>Send product feedback</strong>
              <p>Only this text and your username are sent to the Fizzer server owner. Your guide conversation, notes, files, and traces are not attached.</p>
              <textarea value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder="What should we improve?" rows={4} autoFocus />
              {feedbackError && <span className="documentation-assistant-error" role="alert">{feedbackError}</span>}
              {feedbackState === 'sent' && <span className="documentation-assistant-success" role="status">Feedback sent. Thank you.</span>}
              <div className="documentation-assistant-actions">
                <button type="button" onClick={() => { setFeedbackOpen(false); setFeedbackState('idle'); }}>Back</button>
                <button type="button" disabled={!feedbackDraft.trim() || feedbackState === 'sending'} onClick={() => void sendFeedback()}>
                  {feedbackState === 'sending' ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <textarea
                ref={questionRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
                  if (event.key === 'Escape') close();
                }}
                placeholder="Ask how Fizzer works…"
                rows={2}
                aria-label="Question for the Fizzer guide"
                disabled={Boolean(activeRun)}
              />
              <div className="documentation-assistant-actions">
                <button type="button" className="documentation-assistant-feedback-button" onClick={() => setFeedbackOpen(true)}><Flag size={13} /> Feedback</button>
                {activeRun ? (
                  <button type="button" className="is-danger" onClick={() => void stop()}><Square size={12} /> Stop</button>
                ) : (
                  <button type="button" disabled={!draft.trim() || !vaultId || runnerHealth?.online === false} onClick={() => void submit()}><Send size={13} /> Ask</button>
                )}
              </div>
            </>
          )}
        </footer>}
      </aside>
    </>
  );
}
