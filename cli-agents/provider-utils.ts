/** Small provider diagnostics and output formatting helpers. */
import fs from 'node:fs';
/** Truncates a string to `n` characters, appending an ellipsis if truncated. */
export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}

export function redactGrokDiagnostic(input: string): string {
  return input
    .replace(/"key_prefix":"[^"]*"/g, '"key_prefix":"[redacted]"')
    .replace(/"rt_prefix":"[^"]*"/g, '"rt_prefix":"[redacted]"')
    .replace(/key_prefix":"[^"]*"/g, 'key_prefix":"[redacted]"')
    .replace(/rt_prefix":"[^"]*"/g, 'rt_prefix":"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

export function extractGrokDiagnostic(debugFile: string): string | undefined {
  try {
    if (!fs.existsSync(debugFile)) return undefined;
    const raw = fs.readFileSync(debugFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-300);
    const candidates: string[] = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        const status = ev?.ctx?.status_code ?? ev?.ctx?.http_status;
        const message = ev?.ctx?.message ?? ev?.ctx?.error;
        if (status || message || ev?.lvl === 'error') {
          candidates.push(redactGrokDiagnostic(JSON.stringify({
            level: ev?.lvl,
            message: ev?.msg,
            status,
            detail: message,
          })));
        }
      } catch {
        if (/api error|forbidden|permission-denied|unauthorized|rate|paywall|subscription/i.test(line)) {
          candidates.push(redactGrokDiagnostic(line));
        }
      }
    }
    const detail = candidates.slice(-3).join('\n');
    return detail || undefined;
  } catch {
    return undefined;
  }
}

