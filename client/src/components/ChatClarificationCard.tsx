import { useState } from 'react';
import { api } from '../api';
import { patchWorkItem } from '../chat/workItems';
import type { ChatMessage } from '../chat/types';

export function ChatClarificationCard({
  message,
  vaultId,
}: {
  message: ChatMessage;
  vaultId?: string;
}) {
  const clarification = message.clarification!;
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of clarification.questions) init[q.id] = q.answer || '';
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [budgetEditing, setBudgetEditing] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(clarification.tokenBudget || 0);
  const [budgetDraft, setBudgetDraft] = useState(String(clarification.tokenBudget || ''));
  const pending = clarification.status === 'pending';
  const answeredCount = clarification.questions.filter((q) => String(answers[q.id] || '').trim()).length;
  const allAnswered = answeredCount === clarification.questions.length;

  const clarificationAnswers = () => clarification.questions.map((q) => ({
    id: q.id,
    answer: answers[q.id] || '',
  }));

  const runBusy = async (fallback: string, work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  async function saveAnswers() {
    if (!vaultId || !pending) return;
    await runBusy('Could not save answers', async () => {
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/answer`, {
        method: 'POST',
        body: JSON.stringify({
          answers: clarificationAnswers(),
        }),
      });
    });
  }

  async function acceptContract() {
    if (!vaultId || !pending) return;
    await runBusy('Could not accept contract', async () => {
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/answer`, {
        method: 'POST',
        body: JSON.stringify({
          answers: clarificationAnswers(),
        }),
      });
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/accept`, {
        method: 'POST',
        body: JSON.stringify({
          tokenBudget: clarification.tokenBudget || 0,
        }),
      });
    });
  }

  async function saveBudget(nextValue = budgetDraft) {
    const workItemId = clarification.workItemId;
    if (!workItemId) return;
    const next = Math.max(0, Math.floor(Number(nextValue) || 0));
    await runBusy('Could not update token budget', async () => {
      await patchWorkItem(workItemId, { tokenBudget: next });
      setTokenBudget(next);
      setBudgetDraft(next > 0 ? String(next) : '');
      setBudgetEditing(false);
    });
  }

  return (
    <div className={`chat-clarification is-${clarification.status}`} role="form" aria-label="Scope questionnaire">
      <div className="chat-clarification-head">
        <span className="chat-clarification-kicker">Questionnaire</span>
        <strong>{clarification.title}</strong>
        <span className="chat-clarification-status">
          {clarification.status === 'accepted'
            ? (clarification.missionId ? 'mission live' : 'contract live')
            : `${answeredCount}/${clarification.questions.length}`}
        </span>
      </div>
      <p className="chat-clarification-lead">
        {pending
          ? (allAnswered
            ? 'Prefilled — change only disagreements, then Accept → mission.'
            : 'Answer, then Accept → mission.')
          : 'Accepted scope is frozen; the mission drives agents from here.'}
      </p>
      <div className="chat-clarification-questions">
        {clarification.questions.map((q, index) => {
          const options = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
          const kind = q.kind || (options.length ? 'single' : 'text');
          const value = answers[q.id] || '';
          const selected = new Set(
            value.split(/\s*\|\s*|\n/).map((s) => s.trim()).filter(Boolean),
          );
          const toggle = (option: string) => {
            if (!pending || busy) return;
            setAnswers((prev) => {
              if (kind === 'single') return { ...prev, [q.id]: option };
              const cur = new Set(
                String(prev[q.id] || '')
                  .split(/\s*\|\s*|\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
              if (cur.has(option)) cur.delete(option);
              else cur.add(option);
              return { ...prev, [q.id]: Array.from(cur).join(' | ') };
            });
          };
          return (
            <fieldset key={q.id} className={`chat-clarification-q is-${kind}`} disabled={!pending || busy}>
              <legend>
                <span className="chat-clarification-q-num">{index + 1}</span>
                <span>{q.prompt}</span>
              </legend>
              {!pending ? (
                <small>{q.answer || '—'}</small>
              ) : kind !== 'text' && options.length > 0 ? (
                <div
                  className="chat-clarification-choices"
                  role={kind === 'single' ? 'radiogroup' : 'group'}
                  aria-label={q.prompt}
                >
                  {options.map((option) => {
                    const isOn = selected.has(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        role={kind === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={isOn}
                        className={`chat-clarification-choice${kind === 'multi' ? ' is-check' : ''}${isOn ? ' is-selected' : ''}`}
                        onClick={() => toggle(option)}
                      >
                        <span className="chat-clarification-choice-mark" aria-hidden="true" />
                        <span>{option}</span>
                      </button>
                    );
                  })}
                  {kind === 'single' && (
                    <label className="chat-clarification-other">
                      <span>Other</span>
                      <input
                        type="text"
                        value={options.includes(value) ? '' : value}
                        placeholder="Write your own…"
                        onChange={(event) => setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                      />
                    </label>
                  )}
                </div>
              ) : (
                <textarea
                  value={value}
                  onChange={(event) => setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                  rows={2}
                  placeholder="Your answer…"
                />
              )}
            </fieldset>
          );
        })}
      </div>
      {clarification.workItemId ? (
        <div className="chat-clarification-budget">
          {budgetEditing ? (
            <>
              <label>Token budget <input type="number" min="0" step="1000" autoFocus value={budgetDraft} placeholder="No budget" onChange={(event) => setBudgetDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveBudget(); if (event.key === 'Escape') setBudgetEditing(false); }} /></label>
              <button type="button" disabled={busy} onClick={() => void saveBudget()}>Save</button>
              <button type="button" disabled={busy} onClick={() => void saveBudget('0')}>No budget</button>
            </>
          ) : (
            <button type="button" className="chat-clarification-budget-value" onClick={() => setBudgetEditing(true)} title="Change token budget">
              Token budget: {tokenBudget > 0 ? tokenBudget.toLocaleString() : 'No budget'}
            </button>
          )}
        </div>
      ) : clarification.tokenBudget ? <div className="chat-clarification-budget">Token budget: {clarification.tokenBudget.toLocaleString()}</div> : null}
      {(clarification.workItemId || clarification.missionId) && (
        <div className="chat-clarification-contract">
          {clarification.workItemId ? <>Contract <code>{clarification.workItemId.slice(0, 8)}</code></> : null}
          {clarification.workItemId && clarification.missionId ? ' · ' : null}
          {clarification.missionId ? <>Mission <code>{clarification.missionId.slice(0, 8)}</code></> : null}
          {clarification.acceptedBy ? ` · accepted by ${clarification.acceptedBy}` : ''}
        </div>
      )}
      {error && <div className="chat-clarification-error">{error}</div>}
      {pending && vaultId && (
        <div className="chat-clarification-actions">
          <button type="button" disabled={busy} onClick={() => void saveAnswers()}>Save draft</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || !allAnswered}
            title={allAnswered ? 'Accept scope and open mission' : 'Answer every question first'}
            onClick={() => void acceptContract()}
          >
            Accept → mission
          </button>
        </div>
      )}
    </div>
  );
}
