import { useNavigate } from 'react-router-dom';

const minchoFont = "'Shippori Mincho', serif";

export default function NotLoggedIn() {
  const navigate = useNavigate();

  return (
    <div className="feed-root" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'transparent',
      overflow: 'hidden',
      marginTop: '-3em'
    }}>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3rem 2rem 2rem',
        background: 'linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.1) 100%)',
        borderBottom: '1px solid #222',
        flex: 1
      }}>
        <h1 style={{
          fontSize: '3rem',
          fontWeight: 300,
          fontFamily: minchoFont,
          letterSpacing: '0.1em',
          margin: '0 0 2rem 0',
          background: 'linear-gradient(135deg, #dec572 0%, #c1a263 50%, #b5975a 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          Netaris
        </h1>

        <div style={{
          textAlign: 'center',
          maxWidth: '500px'
        }}>
          <p style={{
            fontSize: '1.3rem',
            fontWeight: 300,
            fontFamily: minchoFont,
            color: '#c1a263',
            textShadow: '0 0 20px rgba(193, 162, 99, 0.5), 0 0 40px rgba(193, 162, 99, 0.3)',
            marginBottom: '1rem',
            lineHeight: 1.6
          }}>
             What'll it be?
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', fontSize: '1rem', justifyContent: 'center' }}>
            <span
              style={{
                color: 'var(--main-text)',
                textDecoration: 'underline',
                cursor: 'pointer',
                fontFamily: minchoFont
              }}
              onClick={() => navigate('/login', { state: { mode: 'register' } })}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#c1a263';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--main-text)';
              }}
            >
              Create an Account
            </span>
            <span style={{ color: '#bbb', fontFamily: minchoFont }}>or</span>
            <span
              style={{
                color: 'var(--main-text)',
                textDecoration: 'underline',
                cursor: 'pointer',
                fontFamily: minchoFont
              }}
              onClick={() => navigate('/login', { state: { mode: 'login' } })}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#c1a263';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--main-text)';
              }}
            >
              Sign In
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
