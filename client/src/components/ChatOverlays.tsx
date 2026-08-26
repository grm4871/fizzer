/**
 * Chat dialogs and pointer menus.
 *
 * The parent owns all overlay state and async actions; this module keeps the
 * transcript component focused on rendering and sticky-scroll behaviour.
 */
import type { RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import { Bot, ClipboardList, Flag, Forward, Hash, Reply, Trash2, X } from 'lucide-react';
import type { NoteSummary } from '../api';
import { buildReplyPreview } from '../chat/replies';
import type { ChatAgentRegistration, ChatMessage, ChatMission, SharedChatNote } from '../chat/types';
import type { ChatRelationship } from '../chat/relationships';
import { CHAT_RELATIONSHIPS, CHAT_RELATIONSHIP_LABELS } from '../chat/relationships';
import { CHAT_MARKDOWN_PLUGINS } from './ChatMarkdown';
import { ChatMissionCard } from './ChatMissionCard';
import { ReportDialog } from './ReportDialog';

type ContextMenu = { x: number; y: number; message: ChatMessage };
type ParticipantMenu = { x: number; y: number; username: string; action: 'remove' | 'leave' };
 
type CollaborationTargets = ChatAgentRegistration[];
 
export type ChatOverlaysProps = {
  contextMenu: ContextMenu | null;
  contextMenuRef: RefObject<HTMLDivElement | null>;
  participantMenu: ParticipantMenu | null;
  participantMenuRef: RefObject<HTMLDivElement | null>;
  deleteArmed: boolean;
  setDeleteArmed: (armed: boolean) => void;
  onReply: (message: ChatMessage) => void;
  onStartCollaboration: (message: ChatMessage) => void;
  onStartForward: (message: ChatMessage) => void;
  onAddToKanban: (message: ChatMessage) => void;
  onReport: (message: ChatMessage) => void;
  onDeleteMessage: (message: ChatMessage) => void;
  onParticipantAction: (menu: ParticipantMenu) => void;
  onCollaborateMessage?: (
    channelId: string,
    sourceMessageId: string,
    targetRegistrationId: string,
    relationship: ChatRelationship,
    instruction: string,
  ) => Promise<void>;
  canCollaborate: (message: ChatMessage) => boolean;
  onForwardMessage?: (channelId: string, messageId: string, targetChannelId: string) => Promise<void>;
  vaultId?: string;
  directMessage: boolean;
  onDeleteMessageAvailable?: boolean;
  channelName: string;
  channelId: string;
  missionArchiveOpen: boolean;
  missionArchive: ChatMission[];
  missionArchiveBusy: boolean;
  missionArchiveError: string;
  onRefreshMissionArchive: () => void;
  onCloseMissionArchive: () => void;
  collaborationSource: ChatMessage | null;
  collaborationTargetId: string;
  collaborationTargets: CollaborationTargets;
  collaborationRelationship: ChatRelationship;
  collaborationInstruction: string;
  collaborationBusy: boolean;
  collaborationError: string;
  onSetCollaborationTarget: (value: string) => void;
  onSetCollaborationRelationship: (value: ChatRelationship) => void;
  onSetCollaborationInstruction: (value: string) => void;
  onSubmitCollaboration: (event: React.FormEvent) => void;
  onCloseCollaboration: () => void;
  forwardSource: ChatMessage | null;
  forwardQuery: string;
  forwardTargets: NoteSummary[];
  forwardingTo: string | null;
  forwardError: string;
  onSetForwardQuery: (value: string) => void;
  onForwardTo: (channelId: string) => void;
  onCloseForward: () => void;
  lightboxSrc: string | null;
  onCloseLightbox: () => void;
  sharedNote: SharedChatNote | null;
  onCloseSharedNote: () => void;
  reportMessage: ChatMessage | null;
  onCloseReport: () => void;
};

export function ChatOverlays({
  contextMenu,
  contextMenuRef,
  participantMenu,
  participantMenuRef,
  deleteArmed,
  setDeleteArmed,
  onReply,
  onStartCollaboration,
  onStartForward,
  onAddToKanban,
  onReport,
  onDeleteMessage,
  onParticipantAction,
  onCollaborateMessage,
  canCollaborate,
  onForwardMessage,
  vaultId,
  directMessage,
  onDeleteMessageAvailable,
  channelName,
  channelId,
  missionArchiveOpen,
  missionArchive,
  missionArchiveBusy,
  missionArchiveError,
  onRefreshMissionArchive,
  onCloseMissionArchive,
  collaborationSource,
  collaborationTargetId,
  collaborationTargets,
  collaborationRelationship,
  collaborationInstruction,
  collaborationBusy,
  collaborationError,
  onSetCollaborationTarget,
  onSetCollaborationRelationship,
  onSetCollaborationInstruction,
  onSubmitCollaboration,
  onCloseCollaboration,
  forwardSource,
  forwardQuery,
  forwardTargets,
  forwardingTo,
  forwardError,
  onSetForwardQuery,
  onForwardTo,
  onCloseForward,
  lightboxSrc,
  onCloseLightbox,
  sharedNote,
  onCloseSharedNote,
  reportMessage,
  onCloseReport,
}: ChatOverlaysProps) {
  return (
    <>
      {contextMenu && (
        <div ref={contextMenuRef} className="chat-context-menu" role="menu" aria-label="Message options" style={{ top: contextMenu.y, left: contextMenu.x }} onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => onReply(contextMenu.message)}><Reply size={14} />Reply</button>
          {onCollaborateMessage && canCollaborate(contextMenu.message) && (
            <button type="button" role="menuitem" onClick={() => onStartCollaboration(contextMenu.message)}><Bot size={14} />Ask agent…</button>
          )}
          {onForwardMessage && <button type="button" role="menuitem" onClick={() => onStartForward(contextMenu.message)}><Forward size={14} />Forward</button>}
          {vaultId && !directMessage && <button type="button" role="menuitem" onClick={() => onAddToKanban(contextMenu.message)}><ClipboardList size={14} />Add to kanban</button>}
          {vaultId && !directMessage && <button type="button" role="menuitem" onClick={() => onReport(contextMenu.message)}><Flag size={14} />Report</button>}
          {onDeleteMessageAvailable && (
            <>
              <div className="menu-divider" role="separator" />
              <button type="button" role="menuitem" className={`is-danger${deleteArmed ? ' is-armed' : ''}`} onClick={() => (deleteArmed ? onDeleteMessage(contextMenu.message) : setDeleteArmed(true))}>
                <Trash2 size={14} />{deleteArmed ? 'Delete for everyone?' : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}
      {participantMenu && (
        <div ref={participantMenuRef} className="chat-context-menu" role="menu" aria-label="Participant options" style={{ top: participantMenu.y, left: participantMenu.x }} onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" className="is-danger" onClick={() => onParticipantAction(participantMenu)}>
            {participantMenu.action === 'remove' ? <Trash2 size={14} /> : <X size={14} />}
            {participantMenu.action === 'remove' ? `Remove @${participantMenu.username} from vault` : 'Leave vault'}
          </button>
        </div>
      )}
      {missionArchiveOpen && (
        <div className="chat-mission-archive-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-mission-archive-title" onClick={onCloseMissionArchive}>
          <section className="chat-mission-archive" onClick={(event) => event.stopPropagation()}>
            <header><div><strong id="chat-mission-archive-title">Mission history</strong><span>Durable work in #{channelName}</span></div><div>
              <button type="button" disabled={missionArchiveBusy} onClick={onRefreshMissionArchive}>Refresh</button>
              <button type="button" title="Close" aria-label="Close mission history" onClick={onCloseMissionArchive}><X size={16} /></button>
            </div></header>
            <div className="chat-mission-archive-list">
              {missionArchiveBusy && missionArchive.length === 0 && <div className="chat-mission-archive-empty">Loading missions…</div>}
              {missionArchiveError && <div className="chat-mission-archive-empty is-error">{missionArchiveError}</div>}
              {!missionArchiveBusy && !missionArchiveError && missionArchive.length === 0 && <div className="chat-mission-archive-empty">No missions in this channel yet.</div>}
              {missionArchive.map((mission) => <ChatMissionCard key={mission.id} mission={mission} vaultId={vaultId} channelId={channelId} />)}
            </div>
          </section>
        </div>
      )}
      {collaborationSource && (
        <div className="chat-forward-overlay" role="dialog" aria-modal="true" aria-labelledby="chat-collaboration-title" onClick={() => !collaborationBusy && onCloseCollaboration()}>
          <form className="chat-forward-panel chat-collaboration-panel" onSubmit={onSubmitCollaboration} onClick={(event) => event.stopPropagation()}>
            <div className="chat-forward-head"><strong id="chat-collaboration-title">Ask another agent</strong><button type="button" title="Cancel" disabled={collaborationBusy} onClick={onCloseCollaboration}><X size={14} /></button></div>
            <div className="chat-forward-preview"><strong>{collaborationSource.author}</strong><span>{buildReplyPreview(collaborationSource)}</span></div>
            <label className="chat-collaboration-field">Agent<select value={collaborationTargetId} onChange={(event) => onSetCollaborationTarget(event.target.value)}>{collaborationTargets.map((registration) => <option key={registration.id} value={registration.id}>{registration.displayName} (@{registration.mention})</option>)}</select></label>
            <label className="chat-collaboration-field">Relationship<select value={collaborationRelationship} onChange={(event) => onSetCollaborationRelationship(event.target.value as ChatRelationship)}>{CHAT_RELATIONSHIPS.map((relationship) => <option key={relationship} value={relationship}>{CHAT_RELATIONSHIP_LABELS[relationship]}</option>)}</select></label>
            <label className="chat-collaboration-field">Instruction<textarea autoFocus rows={4} value={collaborationInstruction} onChange={(event) => onSetCollaborationInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && !collaborationBusy) onCloseCollaboration(); }} /></label>
            {collaborationError && <div className="chat-forward-error">{collaborationError}</div>}
            <div className="chat-collaboration-actions"><button type="button" disabled={collaborationBusy} onClick={onCloseCollaboration}>Cancel</button><button type="submit" disabled={collaborationBusy || !collaborationTargetId || !collaborationInstruction.trim()}>{collaborationBusy ? 'Asking…' : 'Ask agent'}</button></div>
          </form>
        </div>
      )}
      {forwardSource && (
        <div className="chat-forward-overlay" role="dialog" aria-modal="true" aria-label="Forward message" onClick={onCloseForward}>
          <div className="chat-forward-panel" onClick={(event) => event.stopPropagation()}>
            <div className="chat-forward-head"><strong>Forward message</strong><button type="button" title="Cancel" onClick={onCloseForward}><X size={14} /></button></div>
            <div className="chat-forward-preview"><strong>{forwardSource.author}</strong><span>{buildReplyPreview(forwardSource)}</span></div>
            <input className="chat-forward-search" value={forwardQuery} autoFocus placeholder="Search channels…" onChange={(event) => onSetForwardQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCloseForward(); if (event.key === 'Enter' && forwardTargets[0]) onForwardTo(forwardTargets[0].id); }} />
            <div className="chat-forward-list">{forwardTargets.length === 0 && <div className="chat-forward-empty">No other channels</div>}{forwardTargets.map((target) => <button key={target.id} type="button" className="chat-forward-target" disabled={forwardingTo !== null} onClick={() => onForwardTo(target.id)}><Hash size={13} /><span>{target.title}</span>{forwardingTo === target.id && <em>sending…</em>}</button>)}</div>
            {forwardError && <div className="chat-forward-error">{forwardError}</div>}
          </div>
        </div>
      )}
      {lightboxSrc && <div className="chat-lightbox" role="dialog" aria-modal="true" onClick={onCloseLightbox}><button type="button" className="chat-lightbox-close" title="Close" onClick={onCloseLightbox}><X size={20} /></button><img src={lightboxSrc} alt="" className="chat-lightbox-image" onClick={(event) => event.stopPropagation()} /></div>}
      {sharedNote && <div className="chat-lightbox" role="dialog" aria-modal="true" onClick={onCloseSharedNote}><article className="chat-shared-note" onClick={(event) => event.stopPropagation()}><header><h2>{sharedNote.title}</h2><button type="button" className="btn-icon" title="Close" onClick={onCloseSharedNote}><X size={18} /></button></header><div className="chat-shared-note-body"><ReactMarkdown remarkPlugins={CHAT_MARKDOWN_PLUGINS}>{sharedNote.content}</ReactMarkdown></div></article></div>}
      {reportMessage && vaultId && <ReportDialog vaultId={vaultId} targetType="message" targetId={reportMessage.id} title={`message from ${reportMessage.author}`} onClose={onCloseReport} />}
    </>
  );
}
