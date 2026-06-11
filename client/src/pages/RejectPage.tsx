interface RejectPageProps {
  channelName: string;
}

export default function RejectPage({ channelName }: RejectPageProps) {
  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '2em'
    }}>
      <div style={{ textAlign: 'center', maxWidth: '600px' }}>
        <h1>Unable to join channel {channelName}</h1>
        <p style={{ fontSize: '18px', marginTop: '1em' }}>
          This is a private channel. Ask someone in there to add you!
        </p>
      </div>
    </div>
  );
}
