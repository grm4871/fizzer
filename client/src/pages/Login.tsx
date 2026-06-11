import { useState } from "react";
import { useLocation } from 'react-router-dom';
import { ProfileData, UserSettings } from '../types';
import PasswordInput from '../components/PasswordInput';

interface LoginProps {
    profile?: ProfileData | null;
    isElectron: boolean;
    onSaveProfile: (data: { username: string; displayName: string; password?: string; color?: string; settings?: UserSettings; mode?: 'login' | 'register' | 'write'; skipNavigation?: boolean; tosAccepted?: boolean }) => Promise<void>;
}

// Username validation regex (1-15 chars, letters, numbers, underscore only)
const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,15}$/;

type LoginMode = 'login' | 'register';

export default function Login({ onSaveProfile }: LoginProps) {
    const location = useLocation();
    const initialMode = (location.state as { mode?: LoginMode })?.mode || 'login';
    const [mode, setMode] = useState<LoginMode>(initialMode);
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [passwordConfirm, setPasswordConfirm] = useState('');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [usernameError, setUsernameError] = useState('');
    const [passwordError, setPasswordError] = useState('');
    const [tosAccepted, setTosAccepted] = useState(false);

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

    const validatePassword = (): boolean => {
        if (!password.trim()) {
            setPasswordError('Password is required');
            return false;
        }

        if (password.length < 6) {
            setPasswordError('Password must be at least 6 characters');
            return false;
        }

        if (mode === 'register' && password !== passwordConfirm) {
            setPasswordError('Passwords do not match');
            return false;
        }

        setPasswordError('');
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

        // Validate based on mode
        if (mode === 'login') {
            if (!username.trim()) {
                setMessage('Username is required');
                return;
            }
            if (!validateUsername(username)) {
                setMessage('Please fix the username format');
                return;
            }
            if (!validatePassword()) {
                return;
            }
        } else if (mode === 'register') {
            if (!username.trim() || !displayName.trim()) {
                setMessage('Username and display name are required');
                return;
            }
            if (!validateUsername(username)) {
                setMessage('Please fix the username format');
                return;
            }
            if (!validatePassword()) {
                return;
            }
            if (!tosAccepted) {
                setMessage('You must accept the Terms of Service to register');
                return;
            }
        }

        setSaving(true);

        try {
            await onSaveProfile({
                username: username.trim(),
                displayName: displayName.trim(),
                password: password || undefined,
                mode: mode,
                tosAccepted: mode === 'register' ? tosAccepted : undefined
            });
            // Token handling is done in onSaveProfile (app-wide) or here if we had direct API access,
            // but onSaveProfile prop implies the parent handles it.
            // Wait, Login.tsx calls onSaveProfile which is passed from App? 
            // Let's check App.tsx to see what onSaveProfile does. 
            // Actually, Login.tsx is just a form. App handles the API call? 
            // Re-reading Login.tsx... no, it calls onSaveProfile.
            // I need to check where Login is used.
            // But wait, the plan said Modify Login.tsx.
            // "Update handleLogin to store the received token".
            // Login.tsx doesn't have handleLogin, it has handleSave.
            // It calls `onSaveProfile`.
            
            setMessage(`${mode === 'register' ? 'Registration' : 'Login'} successful!`);
            setPassword('');
            setPasswordConfirm('');
        } catch (error: any) {
            setMessage(error.message || `Failed to ${mode === 'register' ? 'register' : 'log in'}`);
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



    return (
        <div style={{ height: '100%', overflow: 'auto' }}>
                <div id="sun-header-login" style={{ marginBottom: '1em' }} />

                {/* Download browser button - only if not in Electron */}


        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%', width: '100%', overflow: 'visible' }}>
            {/* Login form */}
            <div className="settings-container" style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: '2em', overflow: 'visible', height: 'auto' }}>
                {/* Logo at the top */}

                {/* Mode Selector - centered above the form */}
                <div className="settings-mode-selector" style={{ marginBottom: '2em', display: 'flex', gap: '1em', justifyContent: 'center' }}>
                    <button
                        onClick={() => {
                            setMode('login');
                            setMessage('');
                        }}
                        className={`rectangle-button ${mode === 'login' ? '' : 'outlined'}`}
                        style={{
                            opacity: mode === 'login' ? 1 : 0.6,
                            background: mode === 'login' ? undefined : 'transparent'
                        }}
                    >
                        Login
                    </button>
                    <button
                        onClick={() => {
                            setMode('register');
                            setMessage('');
                        }}
                        className={`rectangle-button ${mode === 'register' ? '' : 'outlined'}`}
                        style={{
                            opacity: mode === 'register' ? 1 : 0.6,
                            background: mode === 'register' ? undefined : 'transparent'
                        }}
                    >
                        Create Account
                    </button>
                </div>

                <div style={{ maxWidth: '500px', width: '100%' }}>
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
                            autoComplete="username"
                        />
                        {usernameError ? (
                            <p className="settings-hint error">{usernameError}</p>
                        ) : (
                            <p className="settings-hint">Your unique identifier</p>
                        )}
                    </div>

                    {mode === 'register' && (
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
                    )}

                    <div>
                        <label className="settings-label">Password</label>
                        <PasswordInput
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                setPasswordError('');
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Enter password..."
                            className={`settings-input ${passwordError && (mode === 'login' || !passwordConfirm) ? 'error' : ''}`}
                        />
                        <p className="settings-hint">
                            {mode === 'register' ? 'Minimum 6 characters' : 'Your password'}
                        </p>
                    </div>

                    {mode === 'register' && (
                        <div>
                            <label className="settings-label">Confirm Password</label>
                            <PasswordInput
                                value={passwordConfirm}
                                onChange={(e) => {
                                    setPasswordConfirm(e.target.value);
                                    setPasswordError('');
                                }}
                                onKeyDown={handleKeyDown}
                                placeholder="Confirm password..."
                                className={`settings-input ${passwordError ? 'error' : ''}`}
                            />
                        </div>
                    )}

                    {mode === 'register' && (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5em' }}>
                            <input
                                type="checkbox"
                                id="tos-checkbox"
                                checked={tosAccepted}
                                onChange={(e) => setTosAccepted(e.target.checked)}
                                style={{ marginTop: '0.3em', accentColor: '#c1a263' }}
                            />
                            <label htmlFor="tos-checkbox" style={{ color: '#aaa', fontSize: '0.9em', lineHeight: '1.4' }}>
                                I agree to the <a href="/tos" target="_blank" style={{ color: '#c1a263' }}>Terms of Service</a> and <a href="/privacy" target="_blank" style={{ color: '#c1a263' }}>Privacy Policy</a>
                            </label>
                        </div>
                    )}

                    <div className="settings-actions">
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className={`rectangle-button ${saving ? 'disabled' : ''}`}
                        >
                            {saving ? 'Processing...' : mode === 'login' ? 'Login' : 'Create Account'}
                        </button>
                    </div>

                    {message && (
                        <div className={`settings-message ${message.includes('success') || message.includes('successful') ? 'ok' : 'error'}`}>
                            {message}
                        </div>
                    )}
                </div>
                </div>
            </div>
        </div>
        </div>
    );
}
