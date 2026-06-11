import React from 'react';
import { useNavigate } from 'react-router-dom';

const PrivacyPolicy = () => {
    const navigate = useNavigate();

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100%',
            color: '#e8d7b0',
            fontFamily: 'Roboto, sans-serif',
            padding: '2rem'
        }}>
            <div style={{
                maxWidth: '800px',
                width: '100%',
                background: 'rgba(25, 20, 16, 0.95)',
                border: '1px solid #4a3b2a',
                borderRadius: '8px',
                padding: '2rem',
                boxShadow: '0 4px 6px rgba(0, 0, 0, 0.3)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <h1 style={{ margin: 0, fontSize: '1.8rem', color: '#c1a263' }}>Privacy Policy (Beta)</h1>
                    <button
                        onClick={() => navigate(-1)}
                        style={{
                            background: 'transparent',
                            border: '1px solid #c1a263',
                            color: '#c1a263',
                            padding: '0.5rem 1rem',
                            cursor: 'pointer',
                            borderRadius: '4px'
                        }}
                    >
                        Back
                    </button>
                </div>

                <div style={{ lineHeight: '1.6', fontSize: '1rem' }}>
                    <p>
                        At Netaris, we respect your privacy. This policy explains how we handle your data during our Beta phase.
                    </p>

                    <h3 style={{ color: '#e8d7b0' }}>1. Data Collection</h3>
                    <p>We collect information you provide directly to us:</p>
                    <ul style={{ paddingLeft: '1.5rem' }}>
                        <li><strong>Account Info:</strong> Username, display name, and password (hashed).</li>
                        <li><strong>Content:</strong> The text and data you put into your netdocs.</li>
                        <li><strong>Usage Data:</strong> Basic logs of when you access the service (IP address, timestamp) for security and debugging.</li>
                    </ul>

                    <h3 style={{ color: '#e8d7b0' }}>2. Beta Usage Data</h3>
                    <p>
                        During the Beta period, we may inspect server logs more frequently to identify bugs and performance issues. 
                        We do not read your private netdocs unless specifically required to resolve a technical support issue you report, or if required by law.
                    </p>

                    <h3 style={{ color: '#e8d7b0' }}>3. How We Use Data</h3>
                    <ul style={{ paddingLeft: '1.5rem' }}>
                        <li>To provide and maintain the Netaris service.</li>
                        <li>To detect and prevent technical issues.</li>
                        <li>To improve the platform based on usage patterns.</li>
                    </ul>

                    <h3 style={{ color: '#e8d7b0' }}>4. Data Security</h3>
                    <p>
                        We use standard encryption (HTTPS/TLS) for data in transit and secure hashing for passwords. 
                        However, please remember that no method of transmission over the Internet is 100% secure.
                    </p>

                    <p style={{ marginTop: '2rem', fontSize: '0.9rem', color: '#888' }}>
                        Last Updated: January 2026
                    </p>
                </div>
            </div>
        </div>
    );
};

export default PrivacyPolicy;
