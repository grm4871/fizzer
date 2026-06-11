import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Login from '../../pages/Login';
import Settings from '../../pages/Settings';
import PermissionsMenu, { PermissionsData } from '../../pages/PermissionsMenu';
import NetdocReader from '../../pages/NetdocReader';
import NetdocEditor from '../../pages/NetdocEditor';
import NetdocHistory from '../../pages/NetdocHistory';

import New from '../../pages/New';
import Explore from '../../pages/Explore';
import NotLoggedIn from '../../pages/NotLoggedIn';
import TermsOfService from '../../pages/TermsOfService';
import PrivacyPolicy from '../../pages/PrivacyPolicy';
import AdminPanel from '../../pages/AdminPanel';
import Space from '../../pages/Space';
import SpacesMenu from '../../pages/SpacesMenu';
import { PseudoWindow } from '../../components/PseudoWindow';
import { RouteType, LayoutMode } from '../../types/routing';
import { SidebarItem } from '../../types';
import { disconnectSocket } from '../../services/socket';
import { apiFetch } from '../../utils/api';
import { parseNetdocIdFromPath } from '../MainLayout';

interface MainLayoutMiddleProps {
    routeType: RouteType;
    profileId: string;
    username: string;
    displayName: string;
    color: string;
    joinedAt: string;
    sidebarItems: SidebarItem[];
    setCurrentNetdoc: (nd: any) => void;
    setCurrentNetdocError: (err: string) => void;
    fetchSidebarItems: () => void;
    navigateToNetdoc: (id: string, name?: string) => void;
    navigateToNewNetdoc: () => void;
    navigateTo: (path: string) => void;
    isElectron: boolean;
    isAuthenticated: boolean;
    setUsername: (name: string) => void;
    setDisplayName: (name: string) => void;
    setProfileId: (id: string) => void;
    setColor: (color: string) => void;
    setJoinedAt: (date: string) => void;
    setSidebarItems: (items: SidebarItem[]) => void;
    applySpellcheckSetting: () => void;
    layoutMode: LayoutMode;
    setLayoutMode: (mode: LayoutMode) => void;
    currentNetdoc: any;
    setHasUnsavedEditorChanges: (hasChanges: boolean) => void;
    isCreatingNewNetdoc: boolean;
    setIsCreatingNewNetdoc: (creating: boolean) => void;
    newNetdocTitle: string;
    setNewNetdocTitle: (title: string) => void;
    openPermissionsMenu: () => void;
    closePermissionsMenu: () => void;
    showPermissionsMenu: boolean;
    goBack: () => void;
    // Space ID for creating netdocs in a specific space
    currentSpaceId?: string;
    currentSpace?: { id: string; name: string; description?: string; monarchDisplayName?: string; monarchUsername?: string; monarchColor?: string; jacketId?: string; canWrite?: boolean } | null;
    spaceError?: string | null;
}

const MainLayoutMiddle: React.FC<MainLayoutMiddleProps> = ({
    routeType,
    profileId,
    username,
    displayName,
    color,
    joinedAt,
    sidebarItems,
    setCurrentNetdoc,
    setCurrentNetdocError,
    fetchSidebarItems,
    navigateToNetdoc,
    navigateToNewNetdoc,
    navigateTo,
    isElectron,
    isAuthenticated,
    setUsername,
    setDisplayName,
    setProfileId,
    setColor,
    setJoinedAt,
    setSidebarItems,
    applySpellcheckSetting,
    layoutMode,
    setLayoutMode,
    currentNetdoc,
    setHasUnsavedEditorChanges,
    isCreatingNewNetdoc,
    setIsCreatingNewNetdoc,
    newNetdocTitle,
    setNewNetdocTitle,
    openPermissionsMenu,
    closePermissionsMenu,
    showPermissionsMenu,
    goBack,
    currentSpaceId,
    currentSpace,
    spaceError,
}) => {
    const navigate = useNavigate();
    const location = useLocation();

    // Local state for history view
    const [showHistory, setShowHistory] = useState(false);

    // Profile space resolution for /id/:username routes
    const [profileSpaceData, setProfileSpaceData] = useState<{ id: string; name: string; description?: string; monarchDisplayName?: string; monarchUsername?: string; monarchColor?: string; jacketId?: string } | null>(null);
    const [profileSpaceError, setProfileSpaceError] = useState<string | null>(null);

    useEffect(() => {
        if (routeType !== 'profile') { setProfileSpaceData(null); setProfileSpaceError(null); return; }
        const profileUsername = location.pathname.startsWith('/id/')
            ? location.pathname.split('/id/')[1]
            : username;
        if (!profileUsername) return;

        setProfileSpaceData(null);
        setProfileSpaceError(null);

        (async () => {
            try {
                const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileUsername);
                const endpoint = isUuid ? `/api/profile/id/${profileUsername}` : `/api/profile/${profileUsername}`;
                const profileRes = await apiFetch(endpoint);
                if (!profileRes.ok) { setProfileSpaceError('Profile not found'); return; }
                const { profile: p } = await profileRes.json();

                const spacesRes = await apiFetch(`/api/spaces/personal/${p.id}`);
                if (!spacesRes.ok) { setProfileSpaceError('Profile space not found'); return; }
                const { profileSpace } = await spacesRes.json();
                if (!profileSpace) { setProfileSpaceError('Profile space not found'); return; }

                setProfileSpaceData({
                    id: profileSpace.id,
                    name: profileSpace.name,
                    description: profileSpace.description,
                    monarchDisplayName: profileSpace.monarch?.displayName,
                    monarchUsername: profileSpace.monarch?.username,
                    monarchColor: profileSpace.monarch?.color,
                    jacketId: profileSpace.jacket
                });
            } catch (err) {
                console.error('Failed to resolve profile space:', err);
                setProfileSpaceError('Failed to load profile');
            }
        })();
    }, [routeType, location.pathname, username]);

    // Local state for pending permissions (new netdoc creation)
    const [pendingPermissions, setPendingPermissions] = useState<PermissionsData | null>(null);

    // Clear showHistory when route changes
    useEffect(() => {
        setShowHistory(false);
    }, [location.pathname]);

    const handleShowHistory = () => {
        if (layoutMode === 'write') {
            setLayoutMode('read');
        }
        setShowHistory(true);
    };

    const profileProp = React.useMemo(() => profileId ? { id: profileId, username, displayName, color, joinedAt: joinedAt || '' } : null, [username, displayName, color, joinedAt, profileId]);

    // Shared handler for updating profile state and localStorage
    const applyProfileData = (profile: any) => {
        setUsername(profile.username);
        setDisplayName(profile.displayName);
        setProfileId(profile.id);
        if (profile.joinedAt) setJoinedAt(profile.joinedAt);
        if (profile.color) { setColor(profile.color); localStorage.setItem('color', profile.color); }
        if (profile.settings) { localStorage.setItem('localsettings', JSON.stringify(profile.settings)); applySpellcheckSetting(); }
        localStorage.setItem('username', profile.username);
        localStorage.setItem('displayName', profile.displayName);
        localStorage.setItem('profileId', profile.id);
    };

    // Shared netdoc load handler (fallback for NetdocReader/NetdocEditor)
    const handleNetdocLoad = (nd: any) => { setCurrentNetdoc(nd); setCurrentNetdocError(''); };

    return (
        <div className="routes-wrapper" style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
        }}>
            {(() => {
                if (routeType === 'login') {
                    return (
                        <Login
                            profile={profileProp}
                            isElectron={isElectron}
                            onSaveProfile={async ({ username: newUsername, displayName: newDisplayName, password, mode = 'login', tosAccepted }) => {
                                const body: any = { username: newUsername, displayName: newDisplayName };
                                if (password) body.password = password;
                                if (mode === 'register' && tosAccepted) body.tosAccepted = tosAccepted;
                                const res = await apiFetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                                if (res.ok) {
                                    const profile = await res.json();
                                    applyProfileData(profile);
                                    if (profile.token) localStorage.setItem('token', profile.token);
                                    const pendingDraft = localStorage.getItem('netaris_pending_draft');
                                    window.location.href = pendingDraft ? '/netdoc' : (mode === 'register' ? '/netdoc/1' : '/');
                                } else {
                                    if (res.status === 409) throw new Error('Another user already exists with that username! Please choose a different one!');
                                    const errorData = await res.json().catch(() => ({}));
                                    throw new Error(errorData.error || 'Failed to login/register');
                                }
                            }}
                        />
                    );
                }

                if (routeType === 'settings') {
                    return profileId ? (
                        <PseudoWindow onClose={() => navigate(-1)}>
                            <Settings
                                profile={profileProp!}
                                isElectron={isElectron}
                                onSaveProfile={async ({ username: newUsername, displayName: newDisplayName, color: newColor, settings, skipNavigation = false }) => {
                                    const body: any = { id: profileId, username: newUsername, displayName: newDisplayName };
                                    if (newColor !== undefined) body.color = newColor;
                                    if (settings !== undefined) body.settings = settings;
                                    const res = await apiFetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                                    if (res.ok) { applyProfileData(await res.json()); if (!skipNavigation) navigate('/'); }
                                    else { throw new Error('Failed to save profile'); }
                                }}
                                onLogout={() => { disconnectSocket(); localStorage.clear(); setUsername(''); setDisplayName(''); setProfileId(''); setSidebarItems([]); navigate('/login', { replace: true }); }}
                            />
                        </PseudoWindow>
                    ) : null;
                }

                if (routeType === 'tos') {
                    return (
                        <PseudoWindow onClose={() => navigate(-1)}>
                            <TermsOfService />
                        </PseudoWindow>
                    );
                }

                if (routeType === 'privacy') {
                    return (
                        <PseudoWindow onClose={() => navigate(-1)}>
                            <PrivacyPolicy />
                        </PseudoWindow>
                    );
                }

                if (routeType === 'admin') {
                    return profileId ? (
                        <PseudoWindow onClose={() => navigate(-1)}>
                            <AdminPanel />
                        </PseudoWindow>
                    ) : null;
                }

                if (routeType === 'profile') {
                    const profileTarget = location.pathname.split('/id/')[1] || username;
                    const isOwnProfile = profileTarget === username;

                    if (layoutMode === 'write' && profileSpaceData?.jacketId) {
                        return (
                            <NetdocEditor
                                key={`jacket-editor-${profileSpaceData.jacketId}`}
                                netdoc={null}
                                netdocId={profileSpaceData.jacketId}
                                profileId={profileId}
                                onCancel={() => setLayoutMode('read')}
                                onPermissions={openPermissionsMenu}
                                isOwner={isOwnProfile}
                                isElectron={isElectron}
                                hideButtons={showPermissionsMenu}
                                onContentChange={setHasUnsavedEditorChanges}
                            />
                        );
                    }

                    return <Space space={profileSpaceData} error={profileSpaceError} onNavigate={(path) => {
                        const match = path.match(/\/netdoc\/([^/]+)/);
                        if (match) navigateToNetdoc(match[1], '');
                    }}
                    canWrite={isOwnProfile}
                    onPermissions={openPermissionsMenu}
                    onVersions={profileSpaceData?.jacketId ? () => {
                        navigateToNetdoc(profileSpaceData.jacketId!, '');
                        setTimeout(() => handleShowHistory(), 0);
                    } : undefined}
                    hideButtons={showPermissionsMenu}
                    profileId={profileId}
                    />;
                }

                if (isCreatingNewNetdoc) {
                    return (
                        <NetdocEditor
                            key="new-netdoc"
                            isNew={true}
                            netdoc={null}
                            profileId={profileId}
                            spaceId={currentSpaceId}
                            onCreated={(netdocId, netdocName) => {
                                setIsCreatingNewNetdoc(false);
                                setPendingPermissions(null);
                                fetchSidebarItems();
                                navigateToNetdoc(netdocId, netdocName);
                            }}
                            onCancel={() => {
                                setIsCreatingNewNetdoc(false);
                                setPendingPermissions(null);
                                goBack();
                            }}
                            onTitleChange={setNewNetdocTitle}
                            initialTitle={newNetdocTitle}
                            isElectron={isElectron}
                            onPermissions={openPermissionsMenu}
                            pendingPermissions={pendingPermissions}
                            hideButtons={showPermissionsMenu}
                        />
                    );
                }

                if (location.pathname === '/new') {
                    return <New />;
                }

                if (routeType === 'spaces') {
                    if (!isAuthenticated) return <NotLoggedIn />;
                    return <SpacesMenu profileId={profileId} onProfile={() => navigate(`/id/${username}`)} />;
                }

                if (routeType === 'space') {
                    if (!isAuthenticated) {
                        return <NotLoggedIn />;
                    }

                    if (layoutMode === 'write' && currentSpace?.jacketId) {
                        return (
                            <NetdocEditor
                                key={`jacket-editor-${currentSpace.jacketId}`}
                                netdoc={null}
                                netdocId={currentSpace.jacketId}
                                profileId={profileId}
                                onCancel={() => setLayoutMode('read')}
                                onPermissions={openPermissionsMenu}
                                isOwner={currentSpace?.canWrite ?? false}
                                isElectron={isElectron}
                                hideButtons={showPermissionsMenu}
                                onContentChange={setHasUnsavedEditorChanges}
                            />
                        );
                    }

                    return (
                        <Space
                            space={currentSpace}
                            error={spaceError}
                            onNavigate={(path) => {
                                const match = path.match(/\/netdoc\/([^/]+)/);
                                if (match) navigateToNetdoc(match[1], '');
                            }}
                            canWrite={currentSpace?.canWrite}
                            onPermissions={openPermissionsMenu}
                            onVersions={currentSpace?.jacketId ? () => {
                                navigateToNetdoc(currentSpace.jacketId!, '');
                                setTimeout(() => handleShowHistory(), 0);
                            } : undefined}
                            hideButtons={showPermissionsMenu}
                            profileId={profileId}
                        />
                    );
                }

                if (routeType === 'explore') {
                    if (!isAuthenticated) {
                        return <NotLoggedIn />;
                    }
                    return (
                        <Explore
                            userId={profileId}
                            onReplaceTab={(netdocId, netdocName) => {
                                navigateToNetdoc(netdocId, netdocName);
                            }}
                        />
                    );
                }

                if (routeType === 'netdoc') {
                    const netdocId = parseNetdocIdFromPath(location.pathname);
                    if (netdocId) {
                        // Show history view if requested
                        if (showHistory && currentNetdoc) {
                            return (
                                <NetdocHistory
                                    key={`history-${netdocId}`}
                                    netdoc={currentNetdoc}
                                    profileId={profileId}
                                    onNetdocUpdate={setCurrentNetdoc}
                                    onNavigate={(path) => {
                                        const match = path.match(/\/netdoc\/([^/]+)/);
                                        if (match) navigateToNetdoc(match[1], '');
                                    }}
                                    onOpenNetdocInNewTab={navigateToNetdoc}
                                    onClose={() => setShowHistory(false)}
                                />
                            );
                        }

                        // Render based on layoutMode (already adjusted for chats in parent)
                        if (layoutMode === 'read') {
                            // Read mode - show NetdocReader
                            return (
                                <NetdocReader
                                    key={`reader-${netdocId}`}
                                    netdoc={currentNetdoc}
                                    netdocId={netdocId}
                                    profileId={profileId}
                                    onNavigateToNetdoc={navigateToNetdoc}
                                    onOpenNetdocInNewTab={navigateToNetdoc}
                                    onNetdocLoad={handleNetdocLoad}
                                    onPermissions={openPermissionsMenu}
                                    onVersions={handleShowHistory}
                                    isOwner={currentNetdoc?.creator_id === profileId}
                                    isElectron={isElectron}
                                    hideButtons={showPermissionsMenu}
                                />
                            );
                        }

                        if (layoutMode === 'write') {
                            // Regular netdoc edit mode - show NetdocEditor
                            return (
                                <NetdocEditor
                                    key={`editor-${netdocId}`}
                                    netdoc={currentNetdoc}
                                    netdocId={netdocId}
                                    profileId={profileId}
                                    onNetdocUpdate={(updatedNetdoc) => {
                                        setCurrentNetdoc(updatedNetdoc);
                                    }}
                                    onNetdocLoad={handleNetdocLoad}
                                    onCancel={(force) => setLayoutMode('read', force)}
                                    onSaveComplete={() => {}}
                                    onPermissions={openPermissionsMenu}
                                    onVersions={handleShowHistory}
                                    isOwner={currentNetdoc?.creator_id === profileId}
                                    isElectron={isElectron}
                                    hideButtons={showPermissionsMenu}
                                    onContentChange={setHasUnsavedEditorChanges}
                                    onTitleChange={(title) => {
                                        // Update currentNetdoc for header
                                        if (currentNetdoc) {
                                            setCurrentNetdoc({ ...currentNetdoc, name: title });
                                            // Update sidebar item if subscribed
                                            const docId = String(currentNetdoc.id);
                                            setSidebarItems(sidebarItems.map(item =>
                                                item.type === 'netdoc' && String(item.netdocId) === docId
                                                    ? { ...item, title: title }
                                                    : item
                                            ));
                                        }
                                    }}
                                />
                            );
                        }

                    }
                }

                return null;
            })()}

            {/* Permissions menu overlay */}
            {showPermissionsMenu && profileId && (currentNetdoc || isCreatingNewNetdoc || currentSpace || profileSpaceData) && (
                <PseudoWindow onClose={closePermissionsMenu}>
                    <PermissionsMenu
                        netdocId={!(routeType === 'space' || routeType === 'profile') ? currentNetdoc?.id : undefined}
                        spaceId={routeType === 'space' ? currentSpace?.id : routeType === 'profile' ? profileSpaceData?.id : undefined}
                        jacketId={routeType === 'space' ? currentSpace?.jacketId : routeType === 'profile' ? profileSpaceData?.jacketId : undefined}
                        isProfileSpace={routeType === 'profile'}
                        creatorId={profileId}
                        currentUserId={profileId}
                        onClose={closePermissionsMenu}
                        onPermissionChanged={async () => {
                            if (!currentNetdoc?.id) return;
                            try {
                                const res = await apiFetch(`/api/netdoc/${currentNetdoc.id}`);
                                if (res.ok) { const data = await res.json(); setCurrentNetdoc(data); }
                            } catch {}
                        }}
                        isNewMode={isCreatingNewNetdoc}
                        initialPermissions={pendingPermissions ?? undefined}
                        onPermissionsDataChange={isCreatingNewNetdoc ? setPendingPermissions : undefined}
                    />
                </PseudoWindow>
            )}
        </div>
    );
};

export default MainLayoutMiddle;
