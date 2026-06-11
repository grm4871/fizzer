import EditorTemplate, { EditorConfig } from './editor/EditorTemplate';
import './netdoc-editor.css';

interface NewNetdocProps {
  profileId: string;
  onCreated: (netdocId: string, netdocName: string) => void;
  onCancel: () => void;
  onTitleChange?: (title: string) => void;
  initialTitle?: string;
  onContentChange?: (hasChanges: boolean) => void;
  onPermissions?: () => void;
  pendingPermissions?: {
    isUnlisted: boolean;
    readMode?: 'whitelist' | 'blacklist';
    commentMode?: 'whitelist' | 'blacklist';
    writeMode?: 'whitelist' | 'blacklist';
    readUsers: string[];
    editUsers: string[];
    commentUsers: string[];
    readBlacklist: string[];
    editBlacklist: string[];
    commentBlacklist: string[];
  } | null;
  isElectron?: boolean;
  hideButtons?: boolean;
}

export default function NewNetdoc({
  profileId,
  onCreated,
  onCancel,
  onTitleChange,
  initialTitle,
  onContentChange,
  onPermissions,
  pendingPermissions,
  isElectron = false,
  hideButtons = false,
}: NewNetdocProps) {
  const config: EditorConfig = {
    mode: 'new',
    profileId,
    onCreated,
    onCancel,
    onTitleChange,
    initialTitle,
    onContentChange,
    onPermissions,
    pendingPermissions,
    isElectron,
    hideButtons,
  };

  return <EditorTemplate {...config} />;
}
