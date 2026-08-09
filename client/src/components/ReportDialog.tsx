import { useState, type FormEvent } from 'react';
import { Flag, X } from 'lucide-react';
import { api } from '../api';
import { ModalShell } from './ModalShell';

export type ReportTargetType = 'vault' | 'note' | 'message' | 'member';
export type ReportReason = 'spam' | 'harassment' | 'hate' | 'illegal' | 'other';

const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'hate', label: 'Hate or abuse' },
  { value: 'illegal', label: 'Illegal content' },
  { value: 'other', label: 'Other' },
];

export function ReportDialog({ vaultId, targetType, targetId, title, onClose }: {
  vaultId: string;
  targetType: ReportTargetType;
  targetId: string;
  title: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<ReportReason>('spam');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/vaults/${encodeURIComponent(vaultId)}/reports`, {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, reason, detail }),
      });
      setSent(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not send report');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      as="form"
      backdropClassName="overlay-backdrop report-dialog-backdrop"
      dialogClassName="report-dialog"
      ariaLabelledby="report-dialog-title"
      onSubmit={submit}
      onClose={onClose}
    >
        <header>
          <div><Flag size={15} aria-hidden="true" /><h2 id="report-dialog-title">Report {title}</h2></div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close report dialog"><X size={16} /></button>
        </header>
        {sent ? (
          <>
            <p>Your report was sent. Vault owners cannot see who submitted it; the server owner can.</p>
            <div className="report-dialog-actions"><button type="button" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <label>
              Reason
              <select value={reason} onChange={(event) => setReason(event.target.value as ReportReason)}>
                {REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              Details <small>optional</small>
              <textarea value={detail} maxLength={500} rows={4} onChange={(event) => setDetail(event.target.value)} placeholder="Add context for the reviewer." />
              <small>{detail.length}/500</small>
            </label>
            <p>Only this reason, your details, and the target reference are stored—not a copy of the content.</p>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="report-dialog-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
            </div>
          </>
        )}
    </ModalShell>
  );
}
