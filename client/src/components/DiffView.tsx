type Props = { diff: string };

export function DiffView({ diff }: Props) {
  return (
    <pre className="diff-view">
      {diff.split('\n').map((line, index) => (
        <code key={`${index}-${line}`} className={lineClass(line)}>{line || ' '}</code>
      ))}
    </pre>
  );
}

function lineClass(line: string) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'remove';
  if (line.startsWith('@@')) return 'hunk';
  return '';
}
