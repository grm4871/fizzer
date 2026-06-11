import { useState, useEffect } from "react";
import { HexColorPicker, HexColorInput } from "react-colorful";
import ConfirmUpdateSuccess from '../components/ConfirmUpdateSuccess';
import SquareToggle from '../components/SquareToggle';
import PasswordInput from '../components/PasswordInput';
import { applySpellcheckSetting } from '../utils/localSettings';
import { apiFetch } from '../utils/api';
import { ProfileData, UserSettings } from '../types';

interface SettingsProps {
    profile: ProfileData;
    isElectron: boolean;
    onSaveProfile: (data: { username: string; displayName: string; password?: string; color?: string; settings?: UserSettings; mode?: 'login' | 'register' | 'write'; skipNavigation?: boolean }) => Promise<void>;
    onLogout: () => void;
    onClose?: () => void;
}

// Username validation regex (1-15 chars, letters, numbers, underscore only)
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;

// Color conversion utilities
function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === r) {
            h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        } else if (max === g) {
            h = ((b - r) / delta + 2) / 6;
        } else {
            h = ((r - g) / delta + 4) / 6;
        }
    }

    const s = max === 0 ? 0 : delta / max;
    const v = max;

    return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
}

function ColorPicker({ profile, onSaveProfile }: { profile: ProfileData; onSaveProfile: (data: { username: string; displayName: string; color?: string; settings?: UserSettings; mode?: 'login' | 'register' | 'write'; skipNavigation?: boolean }) => Promise<void> }) {
    // Initialize with profile color or default, convert to # format for picker
    const initialColor = profile.color ? `#${profile.color}` : '#d2b34e';
    const [color, setColor] = useState(initialColor);
    const [savedColor, setSavedColor] = useState(initialColor);
    const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');

    // Update when profile changes
    useEffect(() => {
        const newColor = profile.color ? `#${profile.color}` : '#d2b34e';
        setColor(newColor);
        setSavedColor(newColor);
    }, [profile.color]);

    const rgb = hexToRgb(color);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

    const handleChange = async () => {
        setSaveStatus('saving');
        try {
            // Strip the # from the color before saving
            const colorWithoutHash = color.replace('#', '');
            await onSaveProfile({
                username: profile.username,
                displayName: profile.displayName,
                color: colorWithoutHash,
                mode: 'write',
                skipNavigation: true
            });
            setSavedColor(color);
            setSaveStatus('success');
        } catch (error) {
            console.error('Failed to save color:', error);
            setSaveStatus('error');
        }
    };

    const handleReset = () => {
        setColor(savedColor);
    };

    return (
        <div style={{ marginTop: '2em', maxWidth: '500px' }}>
            <h3 className="settings-section-heading">Color Picker</h3>
            <div style={{
                padding: '1.5em',
                background: 'rgba(255,255,255,0.05)',
                borderRadius: '8px',
                display: 'grid',
                gap: '1.5em'
            }}>
                <div style={{
                    width: '300px',
                    height: '300px',
                    marginRight: 'auto'
                }}>
                    <HexColorPicker color={color} onChange={setColor} style={{ width: '100%', height: '100%' }} />
                </div>

                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '1em' }}>
                    <label className="settings-label" style={{ minWidth: '60px', margin: 0 }}>Hex</label>
                    <HexColorInput
                        color={color}
                        onChange={setColor}
                        className="settings-input"
                        style={{ flex: 1 }}
                    />
                </div>

                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '1em' }}>
                    <label className="settings-label" style={{ minWidth: '60px', margin: 0 }}>RGB</label>
                    <div style={{
                        flex: 1,
                        padding: '0.75em',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '4px',
                        fontFamily: 'monospace'
                    }}>
                        {rgb.r}, {rgb.g}, {rgb.b}
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '1em' }}>
                    <label className="settings-label" style={{ minWidth: '60px', margin: 0 }}>HSV</label>
                    <div style={{
                        flex: 1,
                        padding: '0.75em',
                        background: 'rgba(0,0,0,0.2)',
                        borderRadius: '4px',
                        fontFamily: 'monospace'
                    }}>
                        {hsv.h}, {hsv.s}, {hsv.v}
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '1em', marginTop: '1em', alignItems: 'center' }}>
                    <button
                        className="rectangle-button"
                        onClick={handleChange}
                        disabled={saveStatus === 'saving'}
                    >
                        Change
                    </button>
                    <button
                        className="rectangle-button"
                        onClick={handleReset}
                        disabled={saveStatus === 'saving'}
                    >
                        Reset
                    </button>
                    <ConfirmUpdateSuccess
                        status={saveStatus}
                        onDismiss={() => setSaveStatus('idle')}
                    />
                </div>
            </div>
        </div>
    );
}

// Toggle configuration for preferences
const TOGGLE_CONFIG = [
    { key: 'adultMode', labelA: 'Adult Mode Off', labelB: 'Adult Mode On' },
    { key: 'malwareMode', labelA: '"Malware" Mode Off', labelB: '"Malware" Mode On' },
    { key: 'misspellIndicator', labelA: 'Misspell Red Line Indicator Off', labelB: 'Misspell Red Line Indicator On' },
    { key: 'confirmDiscardEdits', labelA: 'Confirm Dialogue for Discarding Edits Off', labelB: 'Confirm Dialogue for Discarding Edits On' },
] as const;

export default function Settings({ profile, isElectron, onSaveProfile, onLogout, onClose }: SettingsProps) {
    const [username, setUsername] = useState(profile.username || '');
    const [displayName, setDisplayName] = useState(profile.displayName || '');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [usernameError, setUsernameError] = useState('');

    // Password change states
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passwordMessage, setPasswordMessage] = useState('');
    const [passwordSaving, setPasswordSaving] = useState(false);

    // Preferences as consolidated objects
    const defaultPrefs = {
        adultMode: false,
        malwareMode: false,
        misspellIndicator: false,
        openLinkNewTab: false,
        confirmDiscardEdits: false,
        showTabs: false,
        editorMode: 'normal' as 'normal' | 'vi'
    };
    const [preferences, setPreferences] = useState(defaultPrefs);
    const [savedPreferences, setSavedPreferences] = useState(defaultPrefs);

    // Save status for ConfirmUpdateSuccess
    const [preferencesSaveStatus, setPreferencesSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');

    // Config directory for Electron (loaded via IPC)
    // Config directory for Electron (loaded via IPC)
    const [, setConfigDir] = useState('');

    // Database location state for Electron
    const [dbPath, setDbPath] = useState('');
    const [savedDbPath, setSavedDbPath] = useState('');

    // Get default database path (full path)
    const getDefaultDbPath = () => {
        const platform = navigator.platform.toLowerCase();
        if (platform.includes('win')) {
            return '%APPDATA%\\netaris\\netaris.db';
        } else {
            return '~/.config/netaris/netaris.db';
        }
    };

    // Load settings from localStorage on mount
    useEffect(() => {
        const savedSettings = localStorage.getItem('localsettings');
        if (savedSettings) {
            try {
                const settings = JSON.parse(savedSettings);
                const loaded = {
                    adultMode: settings.adultMode ?? false,
                    malwareMode: settings.malwareMode ?? false,
                    misspellIndicator: settings.misspellIndicator ?? false,
                    openLinkNewTab: settings.openLinkNewTab ?? false,
                    confirmDiscardEdits: settings.confirmDiscardEdits ?? false,
                    showTabs: settings.showTabs ?? false,
                    editorMode: settings.editorMode ?? 'normal'
                };
                setPreferences(loaded);
                setSavedPreferences(loaded);
            } catch (error) {
                console.error('Failed to parse localsettings:', error);
            }
        }

        // Load Electron config from IPC
        if (isElectron) {
            const loadElectronConfig = async () => {
                try {
                    const [configResult, dirResult] = await Promise.all([
                        window.electronAPI?.getConfig(),
                        window.electronAPI?.getConfigDir()
                    ]);

                    // Load database path
                    if (configResult?.success && configResult.config?.db_path) {
                        setDbPath(configResult.config.db_path);
                        setSavedDbPath(configResult.config.db_path);
                    } else {
                        const defaultPath = getDefaultDbPath();
                        setDbPath(defaultPath);
                        setSavedDbPath(defaultPath);
                    }

                    // Load config directory
                    if (dirResult?.success && dirResult.configDir) {
                        setConfigDir(dirResult.configDir);
                    }
                } catch (error) {
                    console.error('Failed to load Electron config:', error);
                    const defaultPath = getDefaultDbPath();
                    setDbPath(defaultPath);
                    setSavedDbPath(defaultPath);
                }
            };
            loadElectronConfig();
        }
    }, [isElectron]);

    useEffect(() => {
        setUsername(profile.username || '');
        setDisplayName(profile.displayName || '');
    }, [profile]);

    const validateUsername = (value: string): boolean => {
        if (!value.trim()) {
            setUsernameError('Username is required');
            return false;
        }
        if (!USERNAME_REGEX.test(value.trim())) {
            setUsernameError('Username must be 1-15 characters (letters, numbers, underscore only)');
            return false;
        }
        setUsernameError('');
        return true;
    };


    const handleUsernameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setUsername(value);
        // Real-time validation
        if (value.trim()) {
            validateUsername(value);
        } else {
            setUsernameError('');
        }
    };

    const handleSave = async () => {
        setMessage('');

        if (!username.trim() || !displayName.trim()) {
            setMessage('Username and display name are required');
            return;
        }
        if (!validateUsername(username)) {
            setMessage('Please fix the username format');
            return;
        }

        setSaving(true);

        try {
            await onSaveProfile({
                username: username.trim(),
                displayName: displayName.trim(),
                mode: 'write'
            });
            setMessage('Profile updated successfully!');
        } catch (error: any) {
            setMessage(error.message || 'Failed to update profile');
        } finally {
            setSaving(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
        }
    };

    const handleSavePreferences = async () => {
        setPreferencesSaveStatus('saving');

        try {
            await onSaveProfile({
                username: profile.username,
                displayName: profile.displayName,
                settings: preferences as UserSettings,
                mode: 'write',
                skipNavigation: true
            });

            localStorage.setItem('localsettings', JSON.stringify(preferences));
            setSavedPreferences(preferences);
            applySpellcheckSetting();
            setPreferencesSaveStatus('success');
        } catch (error) {
            console.error('Failed to save preferences:', error);
            setPreferencesSaveStatus('error');
        }
    };

    // Check if there are unsaved changes
    const hasPreferencesChanges = (Object.keys(preferences) as (keyof typeof preferences)[])
        .some(key => preferences[key] !== savedPreferences[key]);

    const hasDbPathChanges = dbPath !== savedDbPath;

    const handleSaveDbPath = async () => {
        try {
            const result = await window.electronAPI?.updateDbPath(dbPath);
            if (result?.success) {
                setSavedDbPath(dbPath);
                console.log('Database path saved to config.json:', dbPath);
            } else {
                console.error('Failed to save db path:', result?.error);
                alert('Failed to save database path: ' + (result?.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Failed to save db path:', error);
            alert('Failed to save database path');
        }
    };

    const handleResetDbPath = () => {
        setDbPath(savedDbPath);
    };

    return (
        <div className="settings-container">
            <h2 className="settings-heading">Settings</h2>

            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Profile Information</h3>
                <div style={{
                    padding: '1.5em',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '8px',
                    display: 'grid',
                    gap: '1.5em'
                }}>
                    <div>
                        <label className="settings-label">Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={handleUsernameChange}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter username..."
                            className={`settings-input ${usernameError ? 'error' : ''}`}
                        />
                        {usernameError ? (
                            <p className="settings-hint error">{usernameError}</p>
                        ) : (
                            <p className="settings-hint">Your unique identifier)</p>
                        )}
                    </div>

                    <div>
                        <label className="settings-label">Display Name</label>
                        <input
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter display name..."
                            className="settings-input"
                        />
                        <p className="settings-hint">Your public display name</p>
                    </div>

                    <div className="settings-actions">
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className={`rectangle-button ${saving ? 'disabled' : ''}`}
                        >
                            {saving ? 'Processing...' : 'Save Changes'}
                        </button>
                    </div>

                    {message && (
                        <div className={`settings-message ${message.includes('success') || message.includes('successful') ? 'ok' : 'error'}`}>
                            {message}
                        </div>
                    )}
                </div>
            </div>

            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Account Information</h3>
                <div style={{
                    padding: '1.5em',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '8px',
                    display: 'grid',
                    gap: '1.5em'
                }}>
                    <p className="settings-hint">Joined: {profile.joinedAt ? (() => {
                        try {
                            const joinDate = new Date(profile.joinedAt);
                            if (isNaN(joinDate.getTime())) return 'N/A';
                            const day = joinDate.getDate().toString().padStart(2, '0');
                            const month = joinDate.toLocaleDateString('en-US', { month: 'long' });
                            const year = joinDate.getFullYear();
                            return `${day} ${month} ${year}`;
                        } catch {
                            return 'N/A';
                        }
                    })() : 'N/A'}</p>
                    <div className="settings-actions">
                        <button
                            onClick={onLogout}
                            className="rectangle-button"
                            style={{ background: '#8b4444' }}
                        >
                            Logout
                        </button>
                    </div>
                </div>
            </div>

            {/* Change Password Section */}
            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Change Password</h3>
                <div style={{
                    padding: '1.5em',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '8px',
                    display: 'grid',
                    gap: '1.5em'
                }}>
                    <div>
                        <label className="settings-label">Current Password</label>
                        <PasswordInput
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder="Enter current password..."
                            className="settings-input"
                        />
                    </div>
                    <div>
                        <label className="settings-label">New Password</label>
                        <PasswordInput
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="Enter new password..."
                            className="settings-input"
                        />
                        <p className="settings-hint">Minimum 6 characters</p>
                    </div>
                    <div>
                        <label className="settings-label">Confirm New Password</label>
                        <PasswordInput
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Confirm new password..."
                            className="settings-input"
                        />
                    </div>
                    <div className="settings-actions">
                        <button
                            onClick={async () => {
                                setPasswordMessage('');
                                if (!currentPassword || !newPassword || !confirmPassword) {
                                    setPasswordMessage('All password fields are required');
                                    return;
                                }
                                if (newPassword.length < 6) {
                                    setPasswordMessage('New password must be at least 6 characters');
                                    return;
                                }
                                if (newPassword !== confirmPassword) {
                                    setPasswordMessage('New passwords do not match');
                                    return;
                                }
                                setPasswordSaving(true);
                                try {
                                    const res = await apiFetch('/api/auth/change-password', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ currentPassword, newPassword })
                                    });
                                    if (res.ok) {
                                        setPasswordMessage('Password changed successfully!');
                                        setCurrentPassword('');
                                        setNewPassword('');
                                        setConfirmPassword('');
                                    } else {
                                        const data = await res.json();
                                        setPasswordMessage(data.error || 'Failed to change password');
                                    }
                                } catch (err) {
                                    setPasswordMessage('Failed to change password');
                                } finally {
                                    setPasswordSaving(false);
                                }
                            }}
                            disabled={passwordSaving}
                            className={`rectangle-button ${passwordSaving ? 'disabled' : ''}`}
                        >
                            {passwordSaving ? 'Changing...' : 'Change Password'}
                        </button>
                    </div>
                    {passwordMessage && (
                        <div className={`settings-message ${passwordMessage.includes('success') ? 'ok' : 'error'}`}>
                            {passwordMessage}
                        </div>
                    )}
                </div>
            </div>

            <ColorPicker profile={profile} onSaveProfile={onSaveProfile} />

            <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                <h3 className="settings-section-heading">Preferences</h3>
                <div style={{
                    padding: '1.5em',
                    background: 'rgba(255,255,255,0.05)',
                    borderRadius: '8px',
                    display: 'grid',
                    gap: '1.5em'
                }}>
                    {TOGGLE_CONFIG.map(({ key, labelA, labelB }) => (
                        <SquareToggle
                            key={key}
                            optionA={false}
                            optionB={true}
                            labelA={labelA}
                            labelB={labelB}
                            value={preferences[key]}
                            onChange={(val: string | boolean) => setPreferences(p => ({ ...p, [key]: val as boolean }))}
                        />
                    ))}

                    <div>
                        <label className="settings-label">Editor Mode</label>
                        <select
                            value={preferences.editorMode}
                            onChange={(e) => setPreferences(p => ({ ...p, editorMode: e.target.value as 'normal' | 'vi' | 'monospace' }))}
                            className="settings-input"
                            style={{ cursor: 'pointer' }}
                        >
                            <option value="normal">normal</option>
                            <option value="monospace">monospace</option>
                            <option value="vi">hacker (vi)</option>
                        </select>
                    </div>

                    <div style={{ display: 'flex', gap: '1em', marginTop: '1em', alignItems: 'center' }}>
                        <button
                            className="rectangle-button"
                            onClick={handleSavePreferences}
                            disabled={preferencesSaveStatus === 'saving' || !hasPreferencesChanges}
                        >
                            {hasPreferencesChanges ? 'Click to Save' : 'Saved'}
                        </button>
                        <ConfirmUpdateSuccess
                            status={preferencesSaveStatus}
                            onDismiss={() => setPreferencesSaveStatus('idle')}
                        />
                    </div>
                </div>
            </div>

            {isElectron && (
                <div style={{ marginTop: '2em', maxWidth: '500px' }}>
                    <h3 className="settings-section-heading">Netaris Browser</h3>
                    <div style={{
                        padding: '1.5em',
                        background: 'rgba(255,255,255,0.05)',
                        borderRadius: '8px',
                        display: 'grid',
                        gap: '1.5em'
                    }}>

                        <div>
                            <label className="settings-label">Database Location</label>
                            <input
                                type="text"
                                value={dbPath}
                                onChange={(e) => setDbPath(e.target.value)}
                                placeholder="Enter database path..."
                                className="settings-input"
                            />
                            <p className="settings-hint">Path to local database file</p>
                        </div>

                        <div className="settings-actions" style={{ display: 'flex', gap: '1em' }}>
                            <button
                                className="rectangle-button"
                                onClick={handleSaveDbPath}
                                disabled={!hasDbPathChanges}
                            >
                                {hasDbPathChanges ? 'Save Path' : 'Saved'}
                            </button>
                            <button
                                className="rectangle-button"
                                onClick={handleResetDbPath}
                                disabled={!hasDbPathChanges}
                            >
                                Reset
                            </button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
}
