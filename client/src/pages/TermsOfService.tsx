import React from 'react';
import { useNavigate } from 'react-router-dom';

const TermsOfService = () => {
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
                    <h1 style={{ margin: 0, fontSize: '1.8rem', color: '#c1a263' }}>Beta Agreement & Terms of Service</h1>
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
                    <section style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #c1a263', background: 'rgba(193, 162, 99, 0.1)', borderRadius: '4px' }}>
                        <h2 style={{ color: '#c1a263', marginTop: 0 }}>IMPORTANT NOTICE: BETA SOFTWARE</h2>
                        <p>
                            Netaris is currently in <strong>BETA</strong>. This means the service is still in active development and testing.
                            By using this service, you acknowledge and agree that:
                        </p>
                        <ul style={{ paddingLeft: '1.5rem' }}>
                            <li>The service may contain bugs, errors, and other issues.</li>
                            <li>Reliability, availability, and performance are not guaranteed.</li>
                            <li><strong>Data loss is possible.</strong> While we take backups, you should not rely on Netaris as your sole storage for critical data during this phase.</li>
                            <li>Features may change, break, or be removed without notice.</li>
                        </ul>
                    </section>

                    <h3 style={{ color: '#e8d7b0' }}>1. Acceptance of Terms</h3>
                    <p>By registering for or using Netaris, you agree to bound by these terms.</p>

                    <h3 style={{ color: '#e8d7b0' }}>2. User Content</h3>
                    <p>You retain ownership of the content you create ("netdocs"). You grant us a license to host and display this content as needed to provide the service.</p>

                    <h3 style={{ color: '#e8d7b0' }}>3. Prohibited Conduct</h3>
                    <p>You may not use Netaris for illegal purposes, to distribute malware, or to harass others.</p>

                    <h3 style={{ color: '#e8d7b0' }}>4. No Warranty</h3>
                    <p>THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND.</p>

                    <p style={{ marginTop: '2rem', fontSize: '0.9rem', color: '#888' }}>
                        Last Updated: January 2026
                    </p>
                </div>
            </div>
        </div>
    );
};

export default TermsOfService;
