import { useState, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import PasswordInput from '../components/PasswordInput';

export default function AdminPanel() {
    // Admin verification state
    const [isVerified, setIsVerified] = useState(false);
    const [accessDenied, setAccessDenied] = useState(false);

    useEffect(() => {
        // Try a lightweight admin operation to verify access
        const verifyAdmin = async () => {
            try {
                // Check by attempting the set-admin endpoint with a validation-only request
                const res = await apiFetch('/api/auth/admin/set-admin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetUserId: '', isAdmin: false })
                });
                // If we get 403, user is not admin
                if (res.status === 403) {
                    setAccessDenied(true);
                } else {
                    setIsVerified(true);
                }
            } catch {
                setAccessDenied(true);
            }
        };
        verifyAdmin();
    }, []);
    // Password reset state
    const [searchUsername, setSearchUsername] = useState('');
    const [targetUser, setTargetUser] = useState<{ id: string; username: string; displayName: string } | null>(null);
    const [searchMessage, setSearchMessage] = useState('');
    const [searching, setSearching] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [resetMessage, setResetMessage] = useState('');
    const [resetting, setResetting] = useState(false);

    // Set admin state
    const [adminUsername, setAdminUsername] = useState('');
    const [adminTargetUser, setAdminTargetUser] = useState<{ id: string; username: string; displayName: string } | null>(null);
    const [adminSearchMessage, setAdminSearchMessage] = useState('');
    const [adminSearching, setAdminSearching] = useState(false);
    const [settingAdmin, setSettingAdmin] = useState(false);
    const [adminMessage, setAdminMessage] = useState('');

    // Delete netdoc state
    const [netdocId, setNetdocId] = useState('');
    const [deleteMessage, setDeleteMessage] = useState('');
    const [deleting, setDeleting] = useState(false);

    const handleSearch = async () => {
        if (!searchUsername.trim()) {
            setSearchMessage('Please enter a username');
            return;
        }
        setSearching(true);
        setSearchMessage('');
        setTargetUser(null);
        try {
            const res = await apiFetch(`/api/profile/${searchUsername.trim()}`);
            if (res.ok) {
                const data = await res.json();
                setTargetUser(data.profile);
            } else {
                setSearchMessage('User not found');
            }
        } catch {
            setSearchMessage('Failed to search for user');
        } finally {
            setSearching(false);
        }
    };

    const handleAdminSearch = async () => {
        if (!adminUsername.trim()) {
            setAdminSearchMessage('Please enter a username');
            return;
        }
        setAdminSearching(true);
        setAdminSearchMessage('');
        setAdminTargetUser(null);
        try {
            const res = await apiFetch(`/api/profile/${adminUsername.trim()}`);
            if (res.ok) {
                const data = await res.json();
                setAdminTargetUser(data.profile);
            } else {
                setAdminSearchMessage('User not found');
            }
        } catch {
            setAdminSearchMessage('Failed to search for user');
        } finally {
            setAdminSearching(false);
        }
    };

    const handleResetPassword = async () => {
        if (!targetUser) return;
        if (!newPassword || !confirmPassword) {
            setResetMessage('Both password fields are required');
            return;
        }
        if (newPassword.length < 6) {
            setResetMessage('Password must be at least 6 characters');
            return;
        }
        if (newPassword !== confirmPassword) {
            setResetMessage('Passwords do not match');
            return;
        }
        setResetting(true);
        setResetMessage('');
        try {
            const res = await apiFetch('/api/auth/admin/reset-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserId: targetUser.id, newPassword })
            });
            if (res.ok) {
                setResetMessage(`Password reset successfully for ${targetUser.username}!`);
                setNewPassword('');
                setConfirmPassword('');
                setTargetUser(null);
                setSearchUsername('');
            } else {
                const data = await res.json();
                setResetMessage(data.error || 'Failed to reset password');
            }
        } catch {
            setResetMessage('Failed to reset password');
        } finally {
            setResetting(false);
        }
    };

    const handleSetAdmin = async (isAdmin: boolean) => {
        if (!adminTargetUser) return;
        setSettingAdmin(true);
        setAdminMessage('');
        try {
            const res = await apiFetch('/api/auth/admin/set-admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targetUserId: adminTargetUser.id, isAdmin })
            });
            if (res.ok) {
                setAdminMessage(`${isAdmin ? 'Granted' : 'Revoked'} admin for ${adminTargetUser.username}!`);
                setAdminTargetUser(null);
                setAdminUsername('');
            } else {
                const data = await res.json();
                setAdminMessage(data.error || 'Failed to update admin status');
            }
        } catch {
            setAdminMessage('Failed to update admin status');
        } finally {
            setSettingAdmin(false);
        }
    };

    const handleDeleteNetdoc = async () => {
        if (!netdocId.trim()) {
            setDeleteMessage('Please enter a netdoc ID');
            return;
        }
        setDeleting(true);
        setDeleteMessage('');
        try {
            const res = await apiFetch('/api/auth/admin/delete-netdoc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ netdocId: netdocId.trim() })
            });
            if (res.ok) {
                const data = await res.json();
                setDeleteMessage(`Deleted netdoc "${data.deletedName}" successfully!`);
                setNetdocId('');
            } else {
                const data = await res.json();
                setDeleteMessage(data.error || 'Failed to delete netdoc');
            }
        } catch {
            setDeleteMessage('Failed to delete netdoc');
        } finally {
            setDeleting(false);
        }
    };

    const sectionStyle = {
        padding: '1.5em',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: '8px',
        display: 'grid' as const,
        gap: '1.5em'
    };

    return (
        <div className="settings-container">
            <h2 className="settings-heading">Admin Panel</h2>

            {accessDenied && (
                <div style={{ marginTop: '2em', padding: '2em', background: 'rgba(139, 68, 68, 0.2)', borderRadius: '8px', textAlign: 'center' }}>
                    <p style={{ fontSize: '1.2em', color: '#ff6b6b', margin: 0 }}>Access Denied</p>
                    <p style={{ color: '#aaa', marginTop: '0.5em' }}>You do not have admin privileges.</p>
                </div>
            )}

            {!isVerified && !accessDenied && (
                <div style={{ marginTop: '2em', textAlign: 'center', color: '#aaa' }}>
                    Verifying admin access...
                </div>
            )}

            {isVerified && (
            <>
            {/* Reset User Password */}
            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Reset User Password</h3>
                <div style={sectionStyle}>
                    <div>
                        <label className="settings-label">Search User by Username</label>
                        <div style={{ display: 'flex', gap: '0.5em' }}>
                            <input
                                type="text"
                                value={searchUsername}
                                onChange={(e) => setSearchUsername(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                placeholder="Enter username..."
                                className="settings-input"
                                style={{ flex: 1 }}
                            />
                            <button onClick={handleSearch} disabled={searching} className="rectangle-button">
                                {searching ? '...' : 'Search'}
                            </button>
                        </div>
                        {searchMessage && <p className="settings-hint error" style={{ marginTop: '0.5em' }}>{searchMessage}</p>}
                    </div>
                    {targetUser && (
                        <>
                            <div style={{ padding: '1em', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                                <p style={{ margin: 0, color: '#ccc' }}>
                                    <strong>Selected:</strong> {targetUser.displayName} (@{targetUser.username})
                                </p>
                            </div>
                            <div>
                                <label className="settings-label">New Password</label>
                                <PasswordInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Enter new password..." className="settings-input" />
                            </div>
                            <div>
                                <label className="settings-label">Confirm Password</label>
                                <PasswordInput value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm password..." className="settings-input" />
                            </div>
                            <button onClick={handleResetPassword} disabled={resetting} className="rectangle-button" style={{ background: '#8b4444' }}>
                                {resetting ? 'Resetting...' : 'Reset Password'}
                            </button>
                        </>
                    )}
                    {resetMessage && <div className={`settings-message ${resetMessage.includes('success') ? 'ok' : 'error'}`}>{resetMessage}</div>}
                </div>
            </div>

            {/* Set User Admin */}
            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Set User Admin</h3>
                <div style={sectionStyle}>
                    <div>
                        <label className="settings-label">Search User by Username</label>
                        <div style={{ display: 'flex', gap: '0.5em' }}>
                            <input
                                type="text"
                                value={adminUsername}
                                onChange={(e) => setAdminUsername(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleAdminSearch()}
                                placeholder="Enter username..."
                                className="settings-input"
                                style={{ flex: 1 }}
                            />
                            <button onClick={handleAdminSearch} disabled={adminSearching} className="rectangle-button">
                                {adminSearching ? '...' : 'Search'}
                            </button>
                        </div>
                        {adminSearchMessage && <p className="settings-hint error" style={{ marginTop: '0.5em' }}>{adminSearchMessage}</p>}
                    </div>
                    {adminTargetUser && (
                        <>
                            <div style={{ padding: '1em', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}>
                                <p style={{ margin: 0, color: '#ccc' }}>
                                    <strong>Selected:</strong> {adminTargetUser.displayName} (@{adminTargetUser.username})
                                </p>
                            </div>
                            <div style={{ display: 'flex', gap: '0.5em' }}>
                                <button onClick={() => handleSetAdmin(true)} disabled={settingAdmin} className="rectangle-button" style={{ background: '#4a7c59' }}>
                                    Grant Admin
                                </button>
                                <button onClick={() => handleSetAdmin(false)} disabled={settingAdmin} className="rectangle-button" style={{ background: '#8b4444' }}>
                                    Revoke Admin
                                </button>
                            </div>
                        </>
                    )}
                    {adminMessage && <div className={`settings-message ${adminMessage.includes('!') && !adminMessage.includes('Failed') ? 'ok' : 'error'}`}>{adminMessage}</div>}
                </div>
            </div>

            {/* Delete Netdoc */}
            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Delete Netdoc</h3>
                <div style={sectionStyle}>
                    <div>
                        <label className="settings-label">Netdoc ID</label>
                        <div style={{ display: 'flex', gap: '0.5em' }}>
                            <input
                                type="text"
                                value={netdocId}
                                onChange={(e) => setNetdocId(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleDeleteNetdoc()}
                                placeholder="Enter netdoc ID..."
                                className="settings-input"
                                style={{ flex: 1 }}
                            />
                            <button onClick={handleDeleteNetdoc} disabled={deleting} className="rectangle-button" style={{ background: '#8b4444' }}>
                                {deleting ? 'Deleting...' : 'Delete'}
                            </button>
                        </div>
                        <p className="settings-hint">Enter the netdoc ID (from URL: /netdoc/ID)</p>
                    </div>
                    {deleteMessage && <div className={`settings-message ${deleteMessage.includes('success') ? 'ok' : 'error'}`}>{deleteMessage}</div>}
                </div>
            </div>
            </>
            )}
        </div>
    );
}
