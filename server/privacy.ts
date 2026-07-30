/**
 * Agent-private note blocks.
 *
 * Human-authenticated clients receive the stored Markdown unchanged. Agent
 * access receives stable placeholders so an agent can edit around a private
 * block without seeing or accidentally erasing it.
 *
 * Syntax:
 *   :::private
 *   secret material
 *   :::
 */

export type PrivateBlock = {
  from: number;
  to: number;
  raw: string;
  id: string;
};

const START = /^[\t ]*:::private[\t ]*$/i;
const END = /^[\t ]*:::[\t ]*$/;
const PLACEHOLDER_ID = /\[Private block hidden from agents\. id=([a-z0-9-]+)\]/gi;

function stableBlockId(raw: string, index: number): string {
  // This is an edit-preservation handle, not a secret hash. Avoid a crypto
  // dependency so the parser stays deterministic in every server test/runtime.
  let hash = 2166136261;
  const input = `${index}\0${raw}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `p${(hash >>> 0).toString(36)}-${index + 1}`;
}

type Line = { from: number; to: number; text: string };

function contentLines(content: string): Line[] {
  if (!content) return [];
  const lines: Line[] = [];
  let from = 0;
  while (from < content.length) {
    const newline = content.indexOf('\n', from);
    const to = newline === -1 ? content.length : newline;
    const raw = content.slice(from, to);
    lines.push({ from, to, text: raw.endsWith('\r') ? raw.slice(0, -1) : raw });
    if (newline === -1) break;
    from = newline + 1;
  }
  return lines;
}

export function privateBlocks(content: string): PrivateBlock[] {
  const lines = contentLines(String(content || ''));
  const blocks: PrivateBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!START.test(lines[i].text)) continue;
    let end = content.length;
    let closingLine = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!END.test(lines[j].text)) continue;
      end = lines[j].to;
      closingLine = j;
      break;
    }
    const raw = content.slice(lines[i].from, end);
    blocks.push({
      from: lines[i].from,
      to: end,
      raw,
      id: stableBlockId(raw, blocks.length),
    });
    // An unterminated private block is fail-closed: everything after it is
    // private, so there cannot be another independently parsed block.
    if (closingLine >= lines.length) break;
    i = closingLine;
  }
  return blocks;
}

export function hasPrivateBlocks(content: string): boolean {
  return privateBlocks(content).length > 0;
}

function agentPlaceholder(block: PrivateBlock): string {
  return [
    ':::private',
    `[Private block hidden from agents. id=${block.id}]`,
    ':::',
  ].join('\n');
}

function isAgentPlaceholder(raw: string): boolean {
  PLACEHOLDER_ID.lastIndex = 0;
  return PLACEHOLDER_ID.test(raw);
}

function replaceBlocks(
  content: string,
  replacement: (block: PrivateBlock) => string,
): string {
  const blocks = privateBlocks(content);
  if (!blocks.length) return content;
  let cursor = 0;
  let result = '';
  for (const block of blocks) {
    result += content.slice(cursor, block.from);
    result += replacement(block);
    cursor = block.to;
  }
  return result + content.slice(cursor);
}

export function redactPrivateBlocks(content: string): string {
  return replaceBlocks(
    String(content || ''),
    (block) => isAgentPlaceholder(block.raw) ? block.raw : agentPlaceholder(block),
  );
}

export function redactPrivateBlocksForPublic(content: string): string {
  return replaceBlocks(
    String(content || ''),
    () => '> Private block omitted from the public note.',
  );
}

/**
 * Rehydrate placeholders in an agent-authored full-note update.
 *
 * Existing blocks are mandatory and single-use. Removing, duplicating, or
 * editing a placeholder fails instead of silently deleting the secret.
 */
export function restoreAgentPrivateBlocks(existing: string, incoming: string): string {
  const blocks = privateBlocks(existing);
  if (!blocks.length) {
    PLACEHOLDER_ID.lastIndex = 0;
    if (PLACEHOLDER_ID.test(incoming)) {
      throw new Error('Unknown private block placeholder.');
    }
    return incoming;
  }

  const expectedIds = new Set(blocks.map((block) => block.id));
  PLACEHOLDER_ID.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_ID.exec(incoming)) !== null) {
    if (!expectedIds.has(match[1])) throw new Error('Unknown private block placeholder.');
  }

  let restored = incoming;
  for (const block of blocks) {
    const placeholder = agentPlaceholder(block);
    const occurrences = restored.split(placeholder).length - 1;
    if (occurrences !== 1) {
      throw new Error('Agent edits must preserve every private block placeholder exactly once.');
    }
    restored = restored.replace(placeholder, block.raw);
  }
  return restored;
}

/** Incoming-first alias used by the HTTP note update route. */
export function restorePrivateBlocks(incoming: string, existing: string): string {
  return restoreAgentPrivateBlocks(existing, incoming);
}

/** Recursively redact privacy blocks in any JSON response sent to an agent. */
export function sanitizeAgentJson<T>(value: T): T {
  if (typeof value === 'string') return redactPrivateBlocks(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeAgentJson(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitizeAgentJson(item);
    }
    return output as T;
  }
  return value;
}

/**
 * Restricted JWTs are capabilities for the three agent helpers, not general
 * user sessions. Keep this list intentionally narrow.
 */
export function isAgentApiRequestAllowed(methodRaw: string, path: string): boolean {
  const method = methodRaw.toUpperCase();
  const rules: Array<[string[], RegExp]> = [
    [['GET'], /^\/api\/vaults$/],
    [['GET'], /^\/api\/vaults\/[^/]+$/],
    [['GET'], /^\/api\/vaults\/[^/]+\/(?:folders|notes|search|tags)$/],
    [['POST'], /^\/api\/vaults\/[^/]+\/notes$/],
    [['GET', 'PUT'], /^\/api\/vaults\/[^/]+\/agent-memory$/],
    [['GET', 'POST'], /^\/api\/vaults\/[^/]+\/scratchpad(?:\/[^/]+)*(?:\/close)?$/],
    [['GET', 'POST', 'PATCH'], /^\/api\/vaults\/[^/]+\/channels\/[^/]+\/messages(?:\/[^/]+)?$/],
    [['POST'], /^\/api\/vaults\/[^/]+\/channels\/[^/]+\/distill$/],
    [['PUT'], /^\/api\/vaults\/[^/]+\/channels\/[^/]+\/agents\/[^/]+\/avatar$/],
    [['GET', 'PUT', 'DELETE'], /^\/api\/notes\/[^/]+$/],
    [['POST'], /^\/api\/notes\/[^/]+\/(?:rename|move|unlist|pin|archive)$/],
    [['POST', 'DELETE'], /^\/api\/notes\/[^/]+\/tags(?:\/[^/]+)?$/],
    [['GET'], /^\/api\/notes\/[^/]+\/backlinks$/],
    [['GET'], /^\/api\/notes\/[^/]+\/assets\/[^/]+$/],
  ];
  return rules.some(([methods, pattern]) => methods.includes(method) && pattern.test(path));
}
