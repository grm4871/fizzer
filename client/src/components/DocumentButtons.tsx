import React from 'react';
import { showToast } from './dialogue/Toast';
import gavelSvg from '../icons/gavel.svg';
import doubleBackSvg from '../icons/doubleback.svg';
import clockSvg from '../icons/clock.svg';
import backSvg from '../icons/back.svg';
import cancelSvg from '../icons/cancel.svg';
import shareSvg from '../icons/share.svg';

interface DocumentButtonsProps {
  isOwner: boolean;
  isEditor: boolean;
  docId: string;
  mode: string;
  selectedVersion?: any;
  onCancel?: () => void;
  onSave?: () => void;
  onDownload?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onUpload?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onVersions?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onPermissions?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  canViewHistory?: boolean;
  size?: number;
  className?: string;
  isRemote?: boolean;
  isNewMode?: boolean;
  hasContent?: boolean;
  hasChanges?: boolean;
  // Unused but kept for compatibility
  isBookmarked?: boolean;
  onEdit?: () => void;
  onBookmarkChange?: () => void;
  isElectron?: boolean;
  onToggleRemote?: () => void;
  isLocallyAvailable?: boolean;
  onSyncDown?: () => void;
  onSyncUp?: () => void;
  isOfflineMode?: boolean;
  isLocalOnly?: boolean;
}

type ButtonItem = { iconLine: React.ReactNode; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; title: string; disabled?: boolean };

function ButtonCluster({ items }: { items: ButtonItem[] }) {
  return (
    <div style={{ height: 32, borderRadius: 6, border: "1px solid #555", display: "inline-flex", alignItems: "center", overflow: "hidden", backgroundColor: "transparent" }}>
      {items.map((item, i) => (
        <React.Fragment key={item.title}>
          {i > 0 && <div style={{ width: 1, height: "60%", backgroundColor: "#555" }} />}
          <button type="button" title={item.title} onClick={item.disabled ? undefined : item.onClick}
            style={{ background: "none", border: "none", color: "inherit", padding: 0, width: 32, height: "100%", cursor: item.disabled ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", outline: "none", boxSizing: "border-box", marginLeft: 6, marginRight: 6, opacity: item.disabled ? 0.35 : 1 }}>
            {item.iconLine}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function StandaloneButton({ icon, title, onClick, disabled, style }: { icon: React.ReactNode; title: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; style: React.CSSProperties }) {
  return (
    <button onClick={disabled ? undefined : onClick} title={title} style={{ ...style, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.35 : 1 }}>
      {icon}
    </button>
  );
}

export default function DocumentButtons({
  isOwner, isEditor, docId, mode, selectedVersion = null,
  onCancel, onSave, onDownload, onUpload, onVersions, onPermissions,
  canViewHistory = true, size = 20, className, isRemote = false,
  isNewMode = false, hasContent = false, hasChanges = true,
}: DocumentButtonsProps) {
  const showVersions = mode === 'versions';
  const isWriteMode = mode === 'write';

  const handleShare = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/netdoc/${docId}`);
      showToast("Link copied", "success");
    } catch { showToast("Failed to copy link", "error"); }
  };

  const buttonStyle: React.CSSProperties = {
    background: "transparent", border: "1px solid #555", color: "var(--main-text)", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6,
    width: size + 12, height: size + 12, padding: 0, boxSizing: "border-box",
  };
  const iconStyle: React.CSSProperties = { width: "70%", height: "70%", display: "block" };

  // Icons
  const icons = {
    back: <img src={backSvg} alt="" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
    doubleBack: <img src={doubleBackSvg} alt="" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
    clock: <img src={clockSvg} alt="" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
    cancel: <img src={cancelSvg} alt="" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
    save: <svg style={iconStyle} viewBox="0 0 24 24" fill="none"><path fillRule="evenodd" clipRule="evenodd" d="M5 3C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5.82843C21 5.29799 20.7893 4.78929 20.4142 4.41421L19.5858 3.58579C19.2107 3.21071 18.702 3 18.1716 3H5ZM17 19V14H7V19H5V5H7V9H15V5H18.1716L19 5.82843V19H17Z" fill="currentColor"/><rect x="9" y="15" width="6" height="3" fill="currentColor"/></svg>,
    uploadServer: <svg style={{ ...iconStyle, transform: 'rotate(180deg)' }} viewBox="0 0 24 24" fill="none"><path d="M12 3 L12 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 10 L12 14 L16 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 16 L5 19 C5 20 6 21 7 21 L17 21 C18 21 19 20 19 19 L19 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    uploadLocal: <svg style={iconStyle} viewBox="0 0 24 24" fill="none"><path d="M12 14 L12 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 8 L12 4 L16 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 16 L5 19 C5 20 6 21 7 21 L17 21 C18 21 19 20 19 19 L19 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    downloadServer: <svg style={iconStyle} viewBox="0 0 24 24" fill="none"><path d="M12 10 L12 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 16 L12 20 L16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 8 L5 5 C5 4 6 3 7 3 L17 3 C18 3 19 4 19 5 L19 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    downloadLocal: <svg style={iconStyle} viewBox="0 0 24 24" fill="none"><path d="M12 3 L12 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M8 10 L12 14 L16 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M5 16 L5 19 C5 20 6 21 7 21 L17 21 C18 21 19 20 19 19 L19 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    share: <img src={shareSvg} alt="" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
    permissions: <img src={gavelSvg} alt="Permissions" style={{ ...iconStyle, filter: 'url(#iconColorFilter)', userSelect: 'none', pointerEvents: 'none' }} />,
  };

  // Determine current mode
  type Mode = 'read' | 'write' | 'write-unchanged' | 'new-empty' | 'new-with-content';
  const currentMode: Mode = isNewMode
    ? (hasContent ? 'new-with-content' : 'new-empty')
    : isWriteMode
      ? (hasChanges ? 'write' : 'write-unchanged')
      : 'read';

  // Button definitions
  const stop = (e: React.MouseEvent<HTMLButtonElement>) => e.stopPropagation();
  const buttons = {
    versions: {
      icon: selectedVersion ? icons.doubleBack : showVersions ? icons.back : icons.clock,
      title: selectedVersion ? "Back to versions" : showVersions ? "Back to most recent" : "Show versions",
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onVersions?.(e); },
    },
    cancel: { icon: icons.cancel, title: "Cancel editing", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onCancel?.(); } },
    save: { icon: icons.save, title: "Save", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onSave?.(); } },
    uploadServer: { icon: isRemote ? icons.uploadServer : icons.uploadLocal, title: "Upload document", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onUpload?.(e); } },
    downloadServer: { icon: isRemote ? icons.downloadServer : icons.downloadLocal, title: "Download document", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onDownload?.(e); } },
    share: { icon: icons.share, title: "Share document", onClick: handleShare },
    permissions: { icon: icons.permissions, title: "Permissions", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { stop(e); onPermissions?.(e); }, condition: isOwner && !!onPermissions },
  };

  // Layout type definitions
  type LayoutItem = string | { cluster: (string | { id: string; disabled: boolean })[] };

  // Mode layouts
  const layouts: Record<Mode, LayoutItem[]> = {
    'read': [
      ...(canViewHistory ? ['versions'] : []),
      'downloadServer',
      'share',
      ...(isOwner ? ['permissions'] : []),
    ],
    'write': [
      ...(canViewHistory ? ['versions'] : []),
      { cluster: ['cancel', 'save'] },
      { cluster: ['uploadServer', 'downloadServer'] },
      'share',
      ...(isOwner ? ['permissions'] : []),
    ],
    'write-unchanged': [
      ...(canViewHistory ? ['versions'] : []),
      { cluster: ['cancel', { id: 'save', disabled: true }] },
      { cluster: ['uploadServer', 'downloadServer'] },
      'share',
      'permissions',
    ],
    'new-empty': [
      { cluster: ['cancel', { id: 'save', disabled: true }] },
      { cluster: ['uploadServer', { id: 'downloadServer', disabled: true }] },
      'permissions',
    ],
    'new-with-content': [
      { cluster: ['cancel', 'save'] },
      { cluster: ['uploadServer', 'downloadServer'] },
      'permissions',
    ],
  };

  const layout = layouts[currentMode];

  // Render
  return (
    <div className={className} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {layout.map((item, idx) => {
        if (typeof item === 'string') {
          const btn = buttons[item as keyof typeof buttons];
          if ('condition' in btn && !btn.condition) return null;
          return <StandaloneButton key={idx} icon={btn.icon} title={btn.title} onClick={btn.onClick} style={buttonStyle} />;
        }
        if ('cluster' in item) {
          const clusterItems: ButtonItem[] = item.cluster.map(c => {
            const id = typeof c === 'string' ? c : c.id;
            const disabled = typeof c === 'object' && c.disabled;
            const btn = buttons[id as keyof typeof buttons];
            return { iconLine: btn.icon, title: btn.title, onClick: btn.onClick, disabled };
          });
          return <ButtonCluster key={idx} items={clusterItems} />;
        }
        return null;
      })}
    </div>
  );
}
