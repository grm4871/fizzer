import { useEffect, useState } from 'react';
import { Download, ShieldCheck, X } from 'lucide-react';
import {
  checkAndroidUpdate,
  installAndroidUpdate,
  type AndroidUpdateMetadata,
} from '../androidUpdater';

export function AndroidUpdatePrompt() {
  const [metadata, setMetadata] = useState<AndroidUpdateMetadata | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkAndroidUpdate().then((update) => setMetadata(update?.metadata || null)).catch(() => {});
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  if (!metadata || dismissed) return null;

  const install = async () => {
    setBusy(true);
    setMessage('Downloading signed update…');
    try {
      const result = await installAndroidUpdate(metadata, ({ downloaded, total }) => {
        setPercent(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
      });
      await result.removeListener();
      if (result.permissionRequired) {
        setMessage('Allow installs from Fizzer, return here, then tap Install update again.');
        setBusy(false);
      } else {
        setMessage('Android installer opened.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not install the update.');
      setBusy(false);
    }
  };

  return (
    <section className="android-update-card" role="dialog" aria-modal="false" aria-labelledby="android-update-title">
      <button type="button" className="btn-icon" aria-label="Remind me later" onClick={() => setDismissed(true)}><X size={15} /></button>
      <div className="android-update-mark"><Download size={18} /></div>
      <div>
        <span className="surface-kicker">Android beta update</span>
        <strong id="android-update-title">Fizzer {metadata.versionName}</strong>
        <p><ShieldCheck size={13} /> Signature checked before Android installs it.</p>
        {message && <small role="status">{message}{percent != null && busy ? ` ${percent}%` : ''}</small>}
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install()}>
        {busy ? 'Downloading…' : 'Install update'}
      </button>
    </section>
  );
}
