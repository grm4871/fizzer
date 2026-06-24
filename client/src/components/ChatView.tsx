import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Hash, Send } from 'lucide-react';

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';

export interface ChatMessage {
  id: string;
  channelId: string;
  author: string;
  body: string;
  createdAt: string;
  status?: 'sending' | 'running' | 'failed';
  agentId?: string;
}

interface ChatViewProps {
  channelId: string;
  channelName: string;
  messages: ChatMessage[];
  currentUser: string;
  agents: Array<{ id: string; label: string; models: Array<{ id: string; label: string }> }>;
  selectedModels: Record<string, string>;
  onSetAgentModel: (agentId: string, model: string) => void;
  onSendMessage: (channelId: string, body: string) => void;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function initialFor(name: string) {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

function ChatAvatar({
  name,
  kind,
  size = 'md',
}: {
  name: string;
  kind: 'agent' | 'human';
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`chat-avatar chat-avatar-${size} chat-avatar-${kind}`} aria-hidden="true">
      {kind === 'agent' ? <Bot size={size === 'sm' ? 14 : 15} /> : initialFor(name)}
    </div>
  );
}

export function ChatView({
  channelId,
  channelName,
  messages,
  currentUser,
  agents,
  selectedModels,
  onSetAgentModel,
  onSendMessage,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [modelMenu, setModelMenu] = useState<{ x: number; y: number; agentId: string } | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    [messages],
  );
  const agentLabels = useMemo(() => new Set(agents.map((agent) => agent.label)), [agents]);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentLabels.has(message.author) ? 'agent' : 'human';
  const humanUsers = useMemo(() => {
    const names = new Set<string>();
    if (currentUser) names.add(currentUser);
    for (const message of messages) {
      if (message.agentId || agentLabels.has(message.author)) continue;
      if (message.author) names.add(message.author);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [agentLabels, currentUser, messages]);
  const activeAgent = modelMenu ? agents.find((agent) => agent.id === modelMenu.agentId) : null;
  const activeAgentModel = activeAgent ? selectedModels[activeAgent.id] ?? activeAgent.models[0]?.id ?? '' : '';

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [sortedMessages.length, channelId]);

  useEffect(() => {
    if (!modelMenu) return;
    const close = () => setModelMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [modelMenu]);

  function openModelMenu(event: React.MouseEvent, agentId: string) {
    event.preventDefault();
    const x = Math.min(event.clientX, window.innerWidth - 260);
    const y = Math.min(event.clientY, window.innerHeight - 280);
    setModelMenu({ x, y, agentId });
  }

  function submit() {
    const body = draft.trim();
    if (!body) return;
    onSendMessage(channelId, body);
    setDraft('');
  }

  return (
    <section className="chat-view">
      <div className="chat-main">
        <header className="chat-header">
          <Hash size={18} />
          <div className="chat-header-copy">
            <h2>{channelName}</h2>
            <span>{sortedMessages.length} messages</span>
          </div>
        </header>

        <div className="chat-messages" role="log" aria-label={`${channelName} messages`}>
          {sortedMessages.length === 0 ? (
            <div className="chat-empty">
              <Hash size={24} />
              <strong>#{channelName}</strong>
            </div>
          ) : (
            sortedMessages.map((message) => (
              <article key={message.id} className={`chat-message ${message.status ? `status-${message.status}` : ''}`}>
                <ChatAvatar name={message.author} kind={getMessageAvatarKind(message)} />
                <div className="chat-message-body">
                  <div className="chat-message-meta">
                    <strong>{message.author}</strong>
                    <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                    {message.status === 'running' && <span className="chat-message-status">working</span>}
                    {message.status === 'failed' && <span className="chat-message-status is-error">failed</span>}
                  </div>
                  <p>{message.body}</p>
                </div>
              </article>
            ))
          )}
          <div ref={endRef} />
        </div>

        <footer className="chat-composer">
          <textarea
            value={draft}
            placeholder={`Message #${channelName}`}
            spellCheck
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="btn-icon" onClick={submit} title="Send message" disabled={!draft.trim()}>
            <Send size={17} />
          </button>
          <span className="chat-current-user">{currentUser}</span>
        </footer>
      </div>

      <aside className="chat-users" aria-label="Chat users">
        {humanUsers.map((name) => (
          <div className="chat-user chat-human" key={name}>
            <div className="chat-user-row">
              <ChatAvatar name={name} kind="human" size="sm" />
              <div className="chat-user-copy">
                <strong>{name}</strong>
                <span>{name === currentUser ? 'you' : 'online'}</span>
              </div>
            </div>
          </div>
        ))}

        {agents.map((agent) => {
          const selectedModel = selectedModels[agent.id] ?? agent.models[0]?.id ?? '';
          return (
            <div
              className="chat-user chat-agent-user"
              key={agent.id}
              onContextMenu={(event) => openModelMenu(event, agent.id)}
              title="Right-click to change model"
            >
              <div className="chat-user-row">
                <ChatAvatar name={agent.label} kind="agent" size="sm" />
                <div className="chat-user-copy">
                  <strong>{agent.label}</strong>
                  <span>{selectedModel || 'no model selected'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </aside>

      {modelMenu && activeAgent && (
        <div
          className="chat-model-menu"
          style={{ left: modelMenu.x, top: modelMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="chat-model-menu-title">{activeAgent.label} model</div>
          {activeAgent.models.length > 0 ? (
            activeAgent.models.map((model) => (
              <button
                key={model.id}
                className={model.id === activeAgentModel ? 'active' : ''}
                onClick={() => {
                  onSetAgentModel(activeAgent.id, model.id);
                  setModelMenu(null);
                }}
              >
                <span>{model.label}</span>
                {model.id === activeAgentModel && <Check size={14} />}
              </button>
            ))
          ) : (
            <input
              className="chat-model-input"
              value={activeAgentModel}
              placeholder="Model ID"
              autoFocus
              onChange={(event) => onSetAgentModel(activeAgent.id, event.target.value)}
            />
          )}
        </div>
      )}
    </section>
  );
}
