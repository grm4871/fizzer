import React from 'react';

interface QueueScreenProps {
  position: number;
}

export const QueueScreen: React.FC<QueueScreenProps> = ({ position }) => {
  if (position <= 0) return null;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.95)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000,
      fontSize: '1.2em',
      textAlign: 'center'
    }}>
      <div style={{
        padding: '3em',
        border: '2px solid #c1a263',
        borderRadius: '8px',
        maxWidth: '400px'
      }}>
        <h1 style={{ color: '#dec572', marginBottom: '0.5em', fontSize: '2em' }}>Server Queue</h1>
        <p style={{ color: '#aaa', marginBottom: '2em', fontSize: '1.1em' }}>
          The server is at capacity
        </p>
        <div style={{
          background: 'linear-gradient(135deg, #c1a263, #e6b800)',
          color: '#000',
          padding: '2em',
          borderRadius: '8px',
          fontWeight: 'bold',
          fontSize: '3em',
          marginBottom: '2em'
        }}>
          #{position}
        </div>
        <p style={{ color: '#aaa', fontSize: '1em' }}>
          You are{' '}
          <span style={{ color: '#dec572', fontWeight: 'bold' }}>
            {position === 1 ? 'next' : `${position} position${position > 1 ? 's' : ''} away`}
          </span>
        </p>
        <p style={{ color: '#666', marginTop: '2em', fontSize: '0.9em' }}>
          Please wait... you will be admitted automatically
        </p>
      </div>
    </div>
  );
};
