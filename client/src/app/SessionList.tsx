import { Bot, Hash } from 'lucide-react';
import type { ActiveSession } from '../components/SessionManager';
import { elapsedLabel, sessionName, sessionRequestText, shortModel } from '../components/SessionManager';

/** Stateless session-row renderer; selection remains owned by the inspector shell. */
export function SessionList({
  sessions,
  selectedId,
  now,
  onSelect,
}: {
  sessions: ActiveSession[];
  selectedId: number | null;
  now: number;
  onSelect: (id: number) => void;
}) {
  return <div className="session-manager-items">
    {sessions.map((session) => {
      const chosen = session.id === selectedId;
      return <button type="button" key={session.id} className={`session-manager-item${chosen ? ' selected' : ''}`} onClick={() => onSelect(session.id)} aria-current={chosen ? 'true' : undefined}>
        <span className="session-manager-avatar"><Bot size={15} /></span>
        <span className="session-manager-item-main">
          <span className="session-manager-item-line"><strong>{sessionName(session)}</strong><em className={session.status}>{session.status}</em></span>
          <span className="session-manager-item-request">{sessionRequestText(session.prompt)}</span>
          <span className="session-manager-item-meta">
            {session.channel_title ? <><Hash size={10} />{session.channel_title}</> : 'note run'}<i />{session.vault_name}<i />{shortModel(session.model)}<i />{elapsedLabel(session.started_at, now)}
          </span>
        </span>
      </button>;
    })}
  </div>;
}
