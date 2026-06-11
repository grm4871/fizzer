import { useState, useEffect } from 'react';

const DISCLAIMER_ACCEPTED_KEY = 'netaris_beta_disclaimer_accepted';
const DISCLAIMER_VERSION = '1'; // Increment to show disclaimer again after updates

export default function BetaDisclaimer() {
  const [showDisclaimer, setShowDisclaimer] = useState(false);

  useEffect(() => {
    const acceptedVersion = localStorage.getItem(DISCLAIMER_ACCEPTED_KEY);
    if (acceptedVersion !== DISCLAIMER_VERSION) {
      setShowDisclaimer(true);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem(DISCLAIMER_ACCEPTED_KEY, DISCLAIMER_VERSION);
    setShowDisclaimer(false);
  };

  if (!showDisclaimer) return null;

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.85)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 99999,
      padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#1a1a1a',
        border: '1px solid #c1a263',
        borderRadius: '8px',
        maxWidth: '600px',
        width: '100%',
        maxHeight: '80vh',
        overflow: 'auto',
        padding: '2rem'
      }}>
        <h2 style={{
          color: '#dec572',
          margin: '0 0 1.5rem 0',
          fontSize: '1.5rem',
          textAlign: 'center'
        }}>
          ⚠️ Private Beta Notice
        </h2>

        <div style={{
          color: '#ccc',
          fontSize: '0.9rem',
          lineHeight: '1.6'
        }}>
          <p style={{ marginTop: 0 }}>
            <strong>Welcome to Netaris.</strong> This application is currently in private beta 
            and is provided on an "as is" and "as available" basis.
          </p>

          <p><strong>NO WARRANTY:</strong> The developers make no representations or warranties 
          of any kind, express or implied, regarding the operation of this service or the 
          information, content, or materials included herein. To the fullest extent permissible 
          by applicable law, we disclaim all warranties, express or implied, including but not 
          limited to implied warranties of merchantability and fitness for a particular purpose.</p>

          <p><strong>USER-GENERATED CONTENT:</strong> This platform may contain content created 
          by users. We do not monitor, endorse, or guarantee the accuracy, completeness,
          usefulness, or sensibilities of any user-generated content. You acknowledge that any reliance on such 
          content is at your own risk.</p>

          <p><strong>DATA LOSS:</strong> As a beta service, data loss may occur without warning. 
          We are not responsible for any loss of data, content, or information stored on this platform.</p>

          <p><strong>LIMITATION OF LIABILITY:</strong> In no event shall the developers be liable 
          for any direct, indirect, incidental, special, consequential, or punitive damages arising 
          out of or relating to your use of this service.</p>

          <p><strong>CHANGES:</strong> We reserve the right to modify, suspend, or discontinue 
          the service at any time without notice.</p>

          <p style={{ marginBottom: 0 }}>
            By clicking "I Understand & Accept" below, you acknowledge that you have read and 
            agree to these terms.
          </p>
        </div>

        <button
          onClick={handleAccept}
          style={{
            display: 'block',
            width: '100%',
            marginTop: '1.5rem',
            padding: '0.75rem 1.5rem',
            backgroundColor: '#c1a263',
            color: '#000',
            border: 'none',
            borderRadius: '4px',
            fontSize: '1rem',
            fontWeight: 'bold',
            cursor: 'pointer',
            transition: 'background-color 0.2s'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#dec572'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#c1a263'}
        >
          I Understand & Accept
        </button>
      </div>
    </div>
  );
}
