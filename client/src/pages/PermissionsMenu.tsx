import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { PermissionSection, fetchUsernamesForIds, PermsMode } from '../components/PermissionEditor';

interface Permission {
  id: string;
  netdoc_id: string;
  permission_type: string;
  user_id: string | null;
  is_blacklist: boolean;
  created_at: string;
}

export interface PermissionsData {
  isUnlisted: boolean;
  hideHistoryFromNonEditors: boolean;
  usersCanChangeTopic: boolean;
  readMode: PermsMode;
  commentMode: PermsMode;
  writeMode: PermsMode;
  readUsers: string[];
  editUsers: string[];
  commentUsers: string[];
  readBlacklist: string[];
  editBlacklist: string[];
  commentBlacklist: string[];
}

interface PermissionsMenuProps {
  netdocId?: string;
  spaceId?: string;
  jacketId?: string; // For spaces - the jacket netdoc ID
  isProfileSpace?: boolean; // For spaces - whether this is a profile space (hides jacket write)
  creatorId: string;
  currentUserId: string;
  onClose: () => void;
  onPermissionChanged?: () => void;
  isNewMode?: boolean;
  isChat?: boolean; // For new mode - whether this is a chat netdoc
  onPermissionsDataChange?: (data: PermissionsData) => void;
  initialPermissions?: PermissionsData;
}

export default function PermissionsMenu({
  netdocId,
  spaceId,
  jacketId,
  isProfileSpace = false,
  creatorId,
  currentUserId,
  onClose,
  onPermissionChanged,
  isNewMode = false,
  isChat: isChatProp = false,
  onPermissionsDataChange,
  initialPermissions
}: PermissionsMenuProps) {
  const isSpaceMode = !!spaceId;
  const entityId = spaceId || netdocId;
  const apiBase = isSpaceMode ? `/api/spaces/${spaceId}` : `/api/netdoc/${netdocId}`;
  const [loading, setLoading] = useState(!isNewMode);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [usernames, setUsernames] = useState<Map<string, string>>(new Map());
  const [isUnlisted, setIsUnlisted] = useState(initialPermissions?.isUnlisted ?? false);
  const [hideHistoryFromNonEditors, setHideHistoryFromNonEditors] = useState(initialPermissions?.hideHistoryFromNonEditors ?? false);
  const [usersCanChangeTopic, setUsersCanChangeTopic] = useState(initialPermissions?.usersCanChangeTopic ?? false);
  const [isChat, setIsChat] = useState(isChatProp);

  // Mode state
  const [readMode, setReadMode] = useState<PermsMode>(initialPermissions?.readMode ?? 'blacklist');
  const [commentMode, setCommentMode] = useState<PermsMode>(initialPermissions?.commentMode ?? 'blacklist');
  const [writeMode, setWriteMode] = useState<PermsMode>(initialPermissions?.writeMode ?? 'whitelist');

  // Jacket permissions (separate from space permissions, for space mode only)
  const [jacketWriteMode, setJacketWriteMode] = useState<PermsMode>('whitelist');
  const [jacketWriteUsers, setJacketWriteUsers] = useState<string[]>([]);
  const [jacketWriteBlacklist, setJacketWriteBlacklist] = useState<string[]>([]);

  // Consolidated permission fields state
  type PermType = 'read' | 'write' | 'comment';
  interface FieldState { users: string[]; blacklist: string[] }
  const [fields, setFields] = useState<Record<PermType, FieldState>>({
    read: { users: initialPermissions?.readUsers ?? [], blacklist: initialPermissions?.readBlacklist ?? [] },
    write: { users: initialPermissions?.editUsers ?? [], blacklist: initialPermissions?.editBlacklist ?? [] },
    comment: { users: initialPermissions?.commentUsers ?? [], blacklist: initialPermissions?.commentBlacklist ?? [] },
  });
  const updateField = (type: PermType, updates: Partial<FieldState>) => setFields(prev => ({ ...prev, [type]: { ...prev[type], ...updates } }));
  const { read: readField, write: writeField, comment: commentField } = fields;

  const isCreator = currentUserId === creatorId;

  // Load current permissions and visibility
  useEffect(() => {
    // Skip loading in new mode - we use initialPermissions or defaults
    if (isNewMode) {
      return;
    }

    if (!isCreator || !currentUserId || !entityId) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        // Fetch netdoc data for visibility settings (skip for spaces)
        if (!isSpaceMode) {
          const netdocRes = await apiFetch(`/api/netdoc/${netdocId}`);
          if (netdocRes.ok) {
            const netdocData = await netdocRes.json();
            setIsUnlisted(netdocData.is_unlisted || false);
            setHideHistoryFromNonEditors(netdocData.hide_history_from_non_editors || false);
            setUsersCanChangeTopic(netdocData.users_can_change_topic || false);
            setIsChat(netdocData.is_chat || false);
          }
        }

        // Fetch modes
        const modeRes = await apiFetch(`${apiBase}/perms-mode`);
        if (modeRes.ok) {
          const modeData = await modeRes.json();
          setReadMode(modeData.read);
          setCommentMode(modeData.comment);
          setWriteMode(modeData.write);
        }

        const permRes = await apiFetch(`${apiBase}/permissions?userId=${currentUserId}`);

        if (!permRes.ok) {
          const errData = await permRes.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to load permissions');
        }
        const permData = await permRes.json();

        // Parse permissions - group by type and blacklist status
        const readPerms = permData.filter((p: Permission) => p.permission_type === 'read' && !p.is_blacklist);
        const editPerms = permData.filter((p: Permission) => p.permission_type === 'write' && !p.is_blacklist);
        const commentPerms = permData.filter((p: Permission) => p.permission_type === 'comment' && !p.is_blacklist);

        const readBlacklistPerms = permData.filter((p: Permission) => p.permission_type === 'read' && p.is_blacklist);
        const editBlacklistPerms = permData.filter((p: Permission) => p.permission_type === 'write' && p.is_blacklist);
        const commentBlacklistPerms = permData.filter((p: Permission) => p.permission_type === 'comment' && p.is_blacklist);

        // Extract user IDs for grants
        const readUserIds = readPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];
        const editUserIds = editPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];
        const commentUserIds = commentPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];

        // Extract user IDs for blacklists
        const readBlacklistIds = readBlacklistPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];
        const editBlacklistIds = editBlacklistPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];
        const commentBlacklistIds = commentBlacklistPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];

        setFields(prev => ({
          read: { ...prev.read, users: readUserIds, blacklist: readBlacklistIds },
          write: { ...prev.write, users: editUserIds, blacklist: editBlacklistIds },
          comment: { ...prev.comment, users: commentUserIds, blacklist: commentBlacklistIds },
        }));

        // Load jacket permissions if in space mode with jacket
        if (isSpaceMode && jacketId) {
          const jacketModeRes = await apiFetch(`/api/netdoc/${jacketId}/perms-mode`);
          if (jacketModeRes.ok) {
            const jacketModeData = await jacketModeRes.json();
            setJacketWriteMode(jacketModeData.write);
          }

          const jacketPermRes = await apiFetch(`/api/netdoc/${jacketId}/permissions?userId=${currentUserId}`);
          if (jacketPermRes.ok) {
            const jacketPermData = await jacketPermRes.json();
            const jacketWritePerms = jacketPermData.filter((p: Permission) => p.permission_type === 'write' && !p.is_blacklist);
            const jacketWriteBlacklistPerms = jacketPermData.filter((p: Permission) => p.permission_type === 'write' && p.is_blacklist);

            const jacketWriteUserIds = jacketWritePerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];
            const jacketWriteBlacklistIds = jacketWriteBlacklistPerms.map((p: Permission) => p.user_id).filter((id: string | null) => id !== null) as string[];

            setJacketWriteUsers(jacketWriteUserIds);
            setJacketWriteBlacklist(jacketWriteBlacklistIds);

            // Add jacket user IDs to username map
            const jacketUserIds = [...jacketWriteUserIds, ...jacketWriteBlacklistIds];
            if (jacketUserIds.length > 0) {
              const jacketUsernameMap = await fetchUsernamesForIds(jacketUserIds);
              setUsernames(prev => new Map([...prev, ...jacketUsernameMap]));
            }
          }
        }

        // Fetch usernames for all user IDs
        const allUserIds = [...new Set([...readUserIds, ...editUserIds, ...commentUserIds, ...readBlacklistIds, ...editBlacklistIds, ...commentBlacklistIds])];
        if (allUserIds.length > 0) {
          const usernameMap = await fetchUsernamesForIds(allUserIds);
          setUsernames(usernameMap);
        }

        setLoading(false);
      } catch (err: any) {
        setError(err.message || 'Failed to load permissions');
        setLoading(false);
      }
    })();
  }, [entityId, currentUserId, isCreator, isNewMode, isSpaceMode, apiBase, jacketId]);

  // Notify parent of permission changes (for new mode)
  useEffect(() => {
    if (onPermissionsDataChange) {
      onPermissionsDataChange({
        isUnlisted,
        hideHistoryFromNonEditors,
        usersCanChangeTopic,
        readMode, commentMode, writeMode,
        readUsers: readField.users, editUsers: writeField.users, commentUsers: commentField.users,
        readBlacklist: readField.blacklist, editBlacklist: writeField.blacklist, commentBlacklist: commentField.blacklist
      });
    }
  }, [isUnlisted, hideHistoryFromNonEditors, usersCanChangeTopic, readMode, commentMode, writeMode, fields, onPermissionsDataChange]);

  // Mode toggle with cascade
  const toggleMode = (permType: PermType) => {
    if (permType === 'read') {
      if (readMode === 'blacklist') {
        // read → whitelist: also set comment and write to whitelist
        setReadMode('whitelist');
        setCommentMode('whitelist');
        setWriteMode('whitelist');
      } else {
        setReadMode('blacklist');
      }
    } else if (permType === 'comment') {
      if (commentMode === 'blacklist') {
        // comment → whitelist: also set write to whitelist
        setCommentMode('whitelist');
        setWriteMode('whitelist');
      } else {
        // comment → blacklist: also set read to blacklist
        setCommentMode('blacklist');
        setReadMode('blacklist');
      }
    } else {
      if (writeMode === 'blacklist') {
        setWriteMode('whitelist');
      } else {
        // write → blacklist: also set comment and read to blacklist
        setWriteMode('blacklist');
        setCommentMode('blacklist');
        setReadMode('blacklist');
      }
    }
  };

  const handleSavePermissions = async () => {
    if (!isCreator || !currentUserId) return;

    // In new mode, permissions are already tracked via onPermissionsDataChange
    // Just close the menu - the data will be used when creating the netdoc
    if (isNewMode) {
      onClose();
      return;
    }

    if (!entityId) return;

    setSaving(true);
    setError('');

    try {
      // Save visibility (netdocs only, not spaces)
      if (!isSpaceMode) {
        const visRes = await apiFetch(`/api/netdoc/${netdocId}/visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isUnlisted, hideHistoryFromNonEditors, usersCanChangeTopic })
        });
        if (!visRes.ok) {
          throw new Error('Failed to save visibility');
        }
      }

      // Save modes
      await apiFetch(`${apiBase}/perms-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ read: readMode, write: writeMode })
      });

      // Save each permission type (grants)
      const permissionUpdates = [
        { type: 'write', users: writeField.users },
        { type: 'read', users: readField.users }
      ];

      // Save blacklists
      const blacklistUpdates = [
        { type: 'read', users: readField.blacklist },
        { type: 'write', users: writeField.blacklist }
      ];

      // Delete all existing permissions first (before creating any new ones)
      for (const perm of permissionUpdates) {
        await apiFetch(`${apiBase}/permissions?userId=${currentUserId}&permissionType=${perm.type}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Now create all new permissions
      for (const perm of permissionUpdates) {
        for (const userId of perm.users) {
          const res = await apiFetch(`${apiBase}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUserId,
              permissionType: perm.type,
              targetUserId: userId === 'private' ? null : userId,
              isBlacklist: false
            })
          });

          if (!res.ok) {
            throw new Error(`Failed to save ${perm.type} permission`);
          }
        }
      }

      // Save blacklist entries
      for (const blacklist of blacklistUpdates) {
        for (const userId of blacklist.users) {
          const res = await apiFetch(`${apiBase}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUserId,
              permissionType: blacklist.type,
              targetUserId: userId,
              isBlacklist: true
            })
          });

          if (!res.ok) {
            throw new Error(`Failed to save ${blacklist.type} blacklist`);
          }
        }
      }

      // Save jacket permissions if in space mode with jacket
      if (isSpaceMode && jacketId) {
        // Save jacket write mode
        await apiFetch(`/api/netdoc/${jacketId}/perms-mode`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ write: jacketWriteMode })
        });

        // Delete existing jacket write permissions
        await apiFetch(`/api/netdoc/${jacketId}/permissions?userId=${currentUserId}&permissionType=write`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' }
        });

        // Create new jacket write grants
        for (const userId of jacketWriteUsers) {
          const res = await apiFetch(`/api/netdoc/${jacketId}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUserId,
              permissionType: 'write',
              targetUserId: userId === 'private' ? null : userId,
              isBlacklist: false
            })
          });

          if (!res.ok) {
            throw new Error('Failed to save jacket write permission');
          }
        }

        // Save jacket write blacklist entries
        for (const userId of jacketWriteBlacklist) {
          const res = await apiFetch(`/api/netdoc/${jacketId}/permissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: currentUserId,
              permissionType: 'write',
              targetUserId: userId,
              isBlacklist: true
            })
          });

          if (!res.ok) {
            throw new Error('Failed to save jacket write blacklist');
          }
        }
      }

      setError(''); // Clear any errors on success
      // Only re-fetch netdoc when creator loses comment access
      if ((commentMode === 'whitelist' && commentField.users.length === 0) ||
          (commentMode === 'blacklist' && commentField.blacklist.includes(currentUserId))) {
        onPermissionChanged?.();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  };

  // Cascade: adding to higher permission also adds to lower ones (write > comment > read)
  const addUserToPermission = (permType: PermType, userId: string) => {
    setFields(prev => {
      const next = { ...prev };
      if (permType === 'write') {
        if (!prev.write.users.includes(userId)) next.write = { ...prev.write, users: [...prev.write.users, userId] };
        if (!prev.comment.users.includes(userId)) next.comment = { ...prev.comment, users: [...prev.comment.users, userId] };
        if (!prev.read.users.includes(userId)) next.read = { ...prev.read, users: [...prev.read.users, userId] };
      } else if (permType === 'comment') {
        if (!prev.comment.users.includes(userId)) next.comment = { ...prev.comment, users: [...prev.comment.users, userId] };
        if (!prev.read.users.includes(userId)) next.read = { ...prev.read, users: [...prev.read.users, userId] };
      } else if (!prev.read.users.includes(userId)) {
        next.read = { ...prev.read, users: [...prev.read.users, userId] };
      }
      return next;
    });
  };

  // Removing from a permission only removes that level and above (write > comment > read)
  const removeUserFromPermission = (permType: PermType, userId: string) => {
    setFields(prev => {
      const filter = (arr: string[]) => arr.filter(id => id !== userId);
      if (permType === 'read') return { read: { ...prev.read, users: filter(prev.read.users) }, comment: { ...prev.comment, users: filter(prev.comment.users) }, write: { ...prev.write, users: filter(prev.write.users) } };
      if (permType === 'comment') return { ...prev, comment: { ...prev.comment, users: filter(prev.comment.users) }, write: { ...prev.write, users: filter(prev.write.users) } };
      return { ...prev, write: { ...prev.write, users: filter(prev.write.users) } };
    });
  };

  // Blacklist helper functions
  const addUserToBlacklist = (permType: PermType, userId: string) => {
    if (!fields[permType].blacklist.includes(userId)) updateField(permType, { blacklist: [...fields[permType].blacklist, userId] });
  };
  const removeUserFromBlacklist = (permType: PermType, userId: string) => {
    updateField(permType, { blacklist: fields[permType].blacklist.filter(id => id !== userId) });
  };

  // Jacket write permission helpers
  const toggleJacketWriteMode = () => {
    setJacketWriteMode(prev => prev === 'blacklist' ? 'whitelist' : 'blacklist');
  };
  const addUserToJacketWrite = (userId: string) => {
    if (!jacketWriteUsers.includes(userId)) setJacketWriteUsers(prev => [...prev, userId]);
  };
  const removeUserFromJacketWrite = (userId: string) => {
    setJacketWriteUsers(prev => prev.filter(id => id !== userId));
  };
  const addUserToJacketBlacklist = (userId: string) => {
    if (!jacketWriteBlacklist.includes(userId)) setJacketWriteBlacklist(prev => [...prev, userId]);
  };
  const removeUserFromJacketBlacklist = (userId: string) => {
    setJacketWriteBlacklist(prev => prev.filter(id => id !== userId));
  };


  if (!isCreator) {
    return (
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.9)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        onClick={onClose}
      >
        <div
          style={{
            background: '#0a0a0a',
            border: '1px solid #c1a263',
            padding: '2em',
            maxWidth: '400px',
            textAlign: 'center',
            color: '#aaa'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <p style={{ margin: '0 0 1em 0', color: '#dec572', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Access Denied</p>
          <p style={{ margin: '0 0 1.5em 0' }}>Only the creator can manage permissions</p>
          <button
            onClick={onClose}
            style={{
              padding: '0.75em 2em',
              background: '#222',
              border: '1px solid #c1a263',
              color: '#dec572',
              cursor: 'pointer',
              fontWeight: 'bold',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontSize: '0.9rem'
            }}
          >
            Close
          </button>
        </div>
      </div>
    );
  }


  return (
    <div className="settings-container">
      {/* Content */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2.5em',
          maxWidth: '600px'
        }}
      >
        {loading ? (
          <div style={{ color: '#aaa', textAlign: 'center', padding: '2em' }}>Initializing permissions...</div>
        ) : error && !saving ? (
          <div style={{ color: '#ff6b6b', background: '#3a1a1a', border: '1px solid #7a4a4a', padding: '1em', borderRadius: '2px' }}>Error: {error}</div>
        ) : (
          <>
            {/* Visibility Section (netdocs only) */}
            {!isSpaceMode && (
            <div style={{ marginBottom: '1.5em' }}>
              <label style={{ color: '#6b98c1', fontWeight: 'bold', display: 'block', marginBottom: '0.75em', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.9rem' }}>
                Visibility
              </label>
              <div style={{ paddingLeft: '24px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', color: '#aaa', cursor: 'pointer', marginBottom: '0.5em' }}>
                  <input
                    type="checkbox"
                    checked={isUnlisted}
                    onChange={(e) => setIsUnlisted(e.target.checked)}
                    style={{ cursor: 'pointer', accentColor: 'var(--dark-accent)' }}
                  />
                  Unlisted (hidden from feed and search, accessible via direct link)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', color: '#aaa', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={hideHistoryFromNonEditors}
                    onChange={(e) => setHideHistoryFromNonEditors(e.target.checked)}
                    style={{ cursor: 'pointer', accentColor: 'var(--dark-accent)' }}
                  />
                  Hide history from non-editors
                </label>
                {isChat && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5em', color: '#aaa', cursor: 'pointer', marginTop: '0.5em' }}>
                    <input
                      type="checkbox"
                      checked={usersCanChangeTopic}
                      onChange={(e) => setUsersCanChangeTopic(e.target.checked)}
                      style={{ cursor: 'pointer', accentColor: 'var(--dark-accent)' }}
                    />
                    Users can change the topic
                  </label>
                )}
              </div>
            </div>
            )}

            {/* Space mode shows separate space write and jacket write sections (but not for profile spaces) */}
            {isSpaceMode && jacketId && !isProfileSpace ? (
              <>
                <PermissionSection title="Space Write Access (who can add items to this space)" color="#6b98c1" mode={writeMode} onToggleMode={() => toggleMode('write')}
                  users={writeField.users} onAddUser={(id) => addUserToPermission('write', id)} onRemoveUser={(id) => removeUserFromPermission('write', id)}
                  blacklist={writeField.blacklist} onAddToBlacklist={(id) => addUserToBlacklist('write', id)} onRemoveFromBlacklist={(id) => removeUserFromBlacklist('write', id)}
                  usernames={usernames} setUsernames={setUsernames} currentUserId={currentUserId} />
                <PermissionSection title="Jacket Write Access (who can edit the space description)" color="#8b7ac1" mode={jacketWriteMode} onToggleMode={toggleJacketWriteMode}
                  users={jacketWriteUsers} onAddUser={addUserToJacketWrite} onRemoveUser={removeUserFromJacketWrite}
                  blacklist={jacketWriteBlacklist} onAddToBlacklist={addUserToJacketBlacklist} onRemoveFromBlacklist={removeUserFromJacketBlacklist}
                  usernames={usernames} setUsernames={setUsernames} currentUserId={currentUserId} />
              </>
            ) : (
              <PermissionSection title="Write Access" color="#6b98c1" mode={writeMode} onToggleMode={() => toggleMode('write')}
                users={writeField.users} onAddUser={(id) => addUserToPermission('write', id)} onRemoveUser={(id) => removeUserFromPermission('write', id)}
                blacklist={writeField.blacklist} onAddToBlacklist={(id) => addUserToBlacklist('write', id)} onRemoveFromBlacklist={(id) => removeUserFromBlacklist('write', id)}
                usernames={usernames} setUsernames={setUsernames} currentUserId={currentUserId} />
            )}
            <PermissionSection title="Read Access" color="#6b98c1" mode={readMode} onToggleMode={() => toggleMode('read')}
              users={readField.users} onAddUser={(id) => addUserToPermission('read', id)} onRemoveUser={(id) => removeUserFromPermission('read', id)}
              blacklist={readField.blacklist} onAddToBlacklist={(id) => addUserToBlacklist('read', id)} onRemoveFromBlacklist={(id) => removeUserFromBlacklist('read', id)}
              usernames={usernames} setUsernames={setUsernames} currentUserId={currentUserId} />

            {/* Action Buttons */}
            <div
              style={{
                display: 'flex',
                gap: '1em',
                marginTop: '1em'
              }}
            >
              <button
                onClick={handleSavePermissions}
                disabled={saving}
                style={{
                  padding: '0.75em 1.5em',
                  background: saving ? '#555' : '#dec572',
                  border: '1px solid #c1a263',
                  color: saving ? '#999' : '#000',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  fontSize: '0.9rem'
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={async () => {
                  await handleSavePermissions();
                  onClose();
                }}
                disabled={saving}
                style={{
                  padding: '0.75em 1.5em',
                  background: '#222',
                  border: '1px solid #c1a263',
                  color: '#dec572',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  fontSize: '0.9rem'
                }}
              >
                Save and Exit
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
