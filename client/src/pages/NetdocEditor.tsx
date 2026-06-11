import { forwardRef } from 'react';
import EditorTemplate, { EditorTemplateHandle, EditorTemplateState, EditorConfig } from './editor/EditorTemplate';
import './netdoc-editor.css';
import './styles.css';

export type NetdocEditorState = EditorTemplateState;
export type NetdocEditorHandle = EditorTemplateHandle;

interface NetdocEditorProps {
  netdoc: any;
  netdocId?: string;
  profileId: string;
  onNetdocUpdate?: (updatedNetdoc: any) => void;
  onNetdocLoad?: (netdoc: any) => void;
  onCancel?: () => void;
  onSaveComplete?: () => void;
  onUpload?: () => void;
  onDownload?: () => void;
  onVersions?: () => void;
  onPermissions?: () => void;
  onBookmarkChange?: () => void;
  onContentChange?: (hasChanges: boolean) => void;
  onTitleChange?: (title: string) => void;
  initialTitle?: string;
  isBookmarked?: boolean;
  isOwner?: boolean;
  isRemote?: boolean;
  isElectron?: boolean;
  hideButtons?: boolean;
  // New mode props - when isNew=true, creates a new netdoc instead of editing existing
  isNew?: boolean;
  onCreated?: (netdocId: string, netdocName: string) => void;
  // Space to add new netdoc to (optional - defaults to profile space)
  spaceId?: string;
  pendingPermissions?: {
    isUnlisted: boolean;
    readUsers: string[];
    editUsers: string[];
    commentUsers: string[];
    readBlacklist: string[];
    editBlacklist: string[];
    commentBlacklist: string[];
  } | null;
}

const NetdocEditor = forwardRef<NetdocEditorHandle, NetdocEditorProps>(({
  netdoc,
  netdocId,
  profileId,
  onNetdocUpdate,
  onNetdocLoad,
  onCancel,
  onSaveComplete,
  onUpload: _onUpload,
  onDownload: _onDownload,
  onVersions,
  onPermissions,
  onBookmarkChange,
  onContentChange,
  onTitleChange,
  initialTitle,
  isBookmarked = false,
  isOwner = false,
  isRemote = true,
  isElectron = false,
  hideButtons = false,
  isNew = false,
  onCreated,
  spaceId,
  pendingPermissions,
}, ref) => {
  const config: EditorConfig = {
    mode: isNew ? 'new' : 'write',
    profileId,
    netdoc,
    netdocId,
    isOwner,
    isBookmarked,
    isRemote,
    spaceId,
    onCreated,
    onNetdocUpdate,
    onNetdocLoad,
    onCancel,
    onSaveComplete,
    onVersions,
    onPermissions,
    onBookmarkChange,
    onContentChange,
    onTitleChange,
    initialTitle,
    pendingPermissions,
    isElectron,
    hideButtons,
  };

  return <EditorTemplate ref={ref} {...config} />;
});

NetdocEditor.displayName = 'NetdocEditor';
export default NetdocEditor;
