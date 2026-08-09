import { Forward, Reply } from 'lucide-react';
import type { ChatMessage } from './ChatView';

/**
 * Renders the reply/forward provenance quotes for a chat message.
 * Shared between ChatView and ChatWorkTrace, which had identical markup.
 * Preserves the exact classNames and DOM structure of the originals.
 */
export function ChatQuoteRefs({ message }: { message: ChatMessage }) {
  return (
    <>
      {message.replyTo && (
        <div className="chat-reply-quote">
          <Reply size={12} />
          <strong>{message.replyTo.author}</strong>
          <span>{message.replyTo.preview}</span>
        </div>
      )}
      {message.forwardedFrom && (
        <div className="chat-forward-quote">
          <Forward size={12} />
          <span>
            Forwarded from <strong>#{message.forwardedFrom.channelName}</strong>
            {' · '}
            {message.forwardedFrom.author}
          </span>
        </div>
      )}
    </>
  );
}
