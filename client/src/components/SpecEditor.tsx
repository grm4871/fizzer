import ReactMarkdown from 'react-markdown';
import type { Spec, SpecStatus, SpecVersion } from '../api';
import { formatDate } from '../api';
import { DiffView } from './DiffView';

type Props = {
  spec: Spec | null;
  content: string;
  dirty: boolean;
  status: string;
  versions: SpecVersion[];
  diff: string;
  preview: boolean;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onPreviewChange: (preview: boolean) => void;
  onDiffLatest: () => void;
};

export function SpecEditor({
  spec,
  content,
  dirty,
  status,
  versions,
  diff,
  preview,
  onContentChange,
  onSave,
  onPreviewChange,
  onDiffLatest,
}: Props) {
  if (!spec) return <section className="document"><div className="empty-state">Choose or create a spec to begin.</div></section>;
  const frontmatter = parseFrontmatter(content);
  const statusValue = isSpecStatus(frontmatter.status) ? frontmatter.status : spec.status;

  return (
    <section className="document">
      <header className="document-header">
        <div>
          <h1>{spec.title}</h1>
          <p>{spec.rel_path} · Updated {formatDate(spec.updated_at)}</p>
        </div>
        <div className="actions">
          {status && <span>{status}</span>}
          <button onClick={() => onPreviewChange(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
          <button disabled={!dirty} onClick={onSave}>Save</button>
        </div>
      </header>

      <div className="frontmatter-strip">
        <label>
          <span>Status</span>
          <select value={statusValue} onChange={(event) => onContentChange(setFrontmatterValue(content, 'status', event.target.value))}>
            {(['draft', 'ready', 'implementing', 'implemented', 'stale'] as SpecStatus[]).map((statusOption) => (
              <option key={statusOption} value={statusOption}>{statusOption}</option>
            ))}
          </select>
        </label>
        <Field label="Targets" value={frontmatter.targets || spec.targets.join(', ')} onChange={(value) => onContentChange(setFrontmatterValue(content, 'targets', value))} />
        <Field label="Depends" value={frontmatter.depends || spec.depends.join(', ')} onChange={(value) => onContentChange(setFrontmatterValue(content, 'depends', value))} />
      </div>

      {preview ? (
        <article className="preview"><ReactMarkdown>{content}</ReactMarkdown></article>
      ) : (
        <textarea
          className="editor"
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          placeholder="Write the implementation spec..."
        />
      )}

      <footer className="history-bar">
        <span>{versions.length} snapshots</span>
        <button onClick={onDiffLatest} disabled={versions.length === 0}>Diff latest</button>
      </footer>
      {diff && <DiffView diff={diff} />}
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function parseFrontmatter(content: string) {
  if (!content.startsWith('---\n')) return {} as Record<string, string>;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const block = content.slice(4, end);
  const values: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^\[(.*)\]$/, '$1').trim();
  }
  return values;
}

function setFrontmatterValue(content: string, key: string, value: string) {
  const normalized = key === 'targets' || key === 'depends' ? `[${value.split(',').map((item) => item.trim()).filter(Boolean).join(', ')}]` : value;
  if (!content.startsWith('---\n')) return `---\n${key}: ${normalized}\n---\n${content}`;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return `---\n${key}: ${normalized}\n---\n${content}`;
  const block = content.slice(4, end);
  const body = content.slice(end);
  const lines = block.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index >= 0) lines[index] = `${key}: ${normalized}`;
  else lines.push(`${key}: ${normalized}`);
  return `---\n${lines.join('\n')}${body}`;
}

function isSpecStatus(value: string | undefined): value is SpecStatus {
  return value === 'draft' || value === 'ready' || value === 'implementing' || value === 'implemented' || value === 'stale';
}
