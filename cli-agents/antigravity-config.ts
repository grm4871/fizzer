/** Antigravity config, model-tier, language-server, and transcript path seam. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export type AntigravityTier = 'flash_lite' | 'flash' | 'pro';
const ANTIGRAVITY_TIERS = new Set<string>(['flash_lite', 'flash', 'pro']);

/** Poll interval while watching transcript.jsonl. */
export const AGY_POLL_MS = 400;
/**
 * Only treat "no new transcript lines" as done after a *final* planner
 * response (no tools). Mid-tool gaps used to kill runs at ~10s.
 */
export const AGY_IDLE_AFTER_FINAL_POLLS = 8; // ~3.2s settle after final text
/** Hard ceiling if the agent stalls mid-tool forever (still far above old 10s). */
export const AGY_STALL_POLLS = 450; // ~3 min with no new lines
/** Wait for transcript.jsonl after new-conversation / send-message. */
export const AGY_TRANSCRIPT_WAIT_MS = 30_000;

export type AgyTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }>;
};

export function antigravityBin(): string {
  return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
}

export function antigravityTranscriptPath(conversationId: string): string {
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

/** Planner narration ("I will view…") is harness/thinking — not a chat reply. */
export function agyIsPlannerMonologue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^I will\b/i.test(t)) return true;
  if (/^I(?:'ll| am going to)\b/i.test(t)) return true;
  if (/^Let me\b/i.test(t)) return true;
  return false;
}

export function resolveAntigravityProjectConfigPath(cwd: string): string | null {
  const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  const absCwd = path.resolve(cwd);
  for (const file of fs.readdirSync(projectsDir)) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(projectsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(absCwd) || content.includes(`file://${absCwd}`)) return filePath;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Patch the Antigravity project config so Cascade hookup runs auto-approve
 * plans/commands instead of blocking on IDE permission prompts.
 */
export function ensureAntigravityCascadeHookup(cwd: string, yolo?: boolean): void {
  const configPath = resolveAntigravityProjectConfigPath(cwd);
  if (!configPath) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return;
  }

  const settings = (data.settings as Record<string, unknown>) || {};
  settings.fileAccessPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  settings.autoExecutionPolicy = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  settings.artifactReviewMode = 'ARTIFACT_REVIEW_MODE_TURBO';
  if (yolo) settings.internetPolicy = 'AGENT_SETTING_POLICY_ALLOW';
  data.settings = settings;

  const absCwd = path.resolve(cwd);
  const grants = new Set<string>();
  const existing = data.permissionGrants as { permissionGrants?: { allow?: string[] } } | undefined;
  for (const g of existing?.permissionGrants?.allow || []) grants.add(g);
  for (const prefix of ['read_file', 'write_file']) {
    grants.add(`${prefix}(${absCwd})`);
    grants.add(`${prefix}(${absCwd}/.env)`);
  }
  for (const cmd of ['npm', 'node', 'npx', 'agentapi', 'curl', 'rg', 'git', 'bash', 'sh', 'tsx', 'tsc']) {
    grants.add(`command(${cmd})`);
  }
  data.permissionGrants = { permissionGrants: { allow: [...grants] } };

  try {
    fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`);
  } catch { /* ignore */ }
}

/** Best-effort LS call to unblock pending plan/permission prompts. */
export function agyLsPost(endpoint: string, body: Record<string, unknown>): boolean {
  const discovered = discoverAntigravityEnv();
  const addr = discovered.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_LS_ADDRESS;
  const token = discovered.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !token) return false;
  const host = addr.includes('://') ? addr : `http://${addr}`;
  const url = `${host.replace(/\/$/, '')}/exa.language_server_pb.LanguageServerService/${endpoint}`;
  try {
    const result = spawnSync(
      'curl',
      [
        '-sS', '-m', '4',
        '-X', 'POST', url,
        '-H', 'Content-Type: application/json',
        '-H', `X-Codeium-Csrf-Token: ${token}`,
        '-d', JSON.stringify(body),
      ],
      { encoding: 'utf8', timeout: 6000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

export function agyTryAutoApprove(conversationId: string): void {
  agyLsPost('ResolveOutstandingSteps', { cascadeId: conversationId });
}

/** Map configured model ids (slugs, enums, labels) to agentapi --model= tiers. */
export function resolveAntigravityModelTier(model?: string | null): AntigravityTier | undefined {
  if (!model || !String(model).trim()) return undefined;
  let raw = String(model).trim();
  if (raw.includes('|')) raw = raw.split('|')[0].trim();
  const lower = raw.toLowerCase();
  if (ANTIGRAVITY_TIERS.has(lower)) return lower as AntigravityTier;

  // GetAvailableModels slugs + enums + human labels.
  // Lite / extra-low → flash_lite
  if (
    /flash_lite|flash-lite|extra-low|flash.*\(low\)|m187\b|m50\b|gemini-2\.5-flash-lite|gemini-3\.1-flash-lite/i.test(raw)
  ) {
    return 'flash_lite';
  }
  // High flash / mid flash / generic flash → flash
  if (
    /flash.*\(high\)|flash.*\(medium\)|m132\b|m20\b|m18\b|m21\b|gemini-3-flash|gemini-3\.5-flash|gemini-2\.5-flash|gemini-3\.1-flash/i.test(raw)
    || lower === 'flash'
  ) {
    return 'flash';
  }
  // Pro family
  if (
    /gemini-2\.5-pro|gemini-3\.1-pro|gemini-pro|pro-high|pro-low|m36\b|m16\b|m37\b|\(high\)|\(low\)/i.test(raw)
    && /pro/i.test(raw)
  ) {
    return 'pro';
  }
  if (/\bpro\b/i.test(raw) && !/flash/i.test(raw)) return 'pro';
  // Claude / GPT-OSS / other cascade slots — agentapi only has tiers; use pro.
  if (/claude|opus|sonnet|gpt|oss|anthropic/i.test(raw)) return 'pro';
  if (/model_placeholder_m/i.test(raw)) return 'pro';
  return undefined;
}

/**
 * Discover Antigravity language_server HTTP address + CSRF + project id.
 * Prefer env, then /proc cmdline + language_server.log, then /proc environ.
 */
export function discoverAntigravityEnv(cwd?: string): Record<string, string> {
  const env: Record<string, string> = { ANTIGRAVITY_AGENT: '1' };

  if (process.env.ANTIGRAVITY_PROJECT_ID) {
    env.ANTIGRAVITY_PROJECT_ID = process.env.ANTIGRAVITY_PROJECT_ID;
  } else {
    try {
      const projectsDir = path.join(os.homedir(), '.gemini', 'config', 'projects');
      if (fs.existsSync(projectsDir)) {
        const files = fs.readdirSync(projectsDir);
        let projectId: string | undefined;
        const searchCwd = cwd ? path.resolve(cwd) : process.cwd();
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const filePath = path.join(projectsDir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(content) as { id?: string; name?: string };
            if (content.includes(searchCwd) || content.includes(`file://${searchCwd}`) || data.name === 'cascade') {
              projectId = data.id || file.replace(/\.json$/, '');
              break;
            }
          } catch { /* ignore */ }
        }
        if (!projectId) {
          const firstJson = files.find((f) => f.endsWith('.json'));
          if (firstJson) projectId = firstJson.replace(/\.json$/, '');
        }
        if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
      }
    } catch { /* ignore */ }
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    env.ANTIGRAVITY_LS_ADDRESS = process.env.ANTIGRAVITY_LS_ADDRESS;
    env.ANTIGRAVITY_CSRF_TOKEN = process.env.ANTIGRAVITY_CSRF_TOKEN;
    return env;
  }

  let token: string | undefined;
  let port: string | undefined;

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const cmdline = fs.readFileSync(`/proc/${file}/cmdline`, 'utf-8');
        if (!cmdline.includes('language_server')) continue;
        const parts = cmdline.split('\0');
        const tokenIdx = parts.indexOf('--csrf_token');
        if (tokenIdx !== -1 && parts[tokenIdx + 1]) {
          token = parts[tokenIdx + 1];
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try {
    const logPath = path.join(os.homedir(), '.config', 'Antigravity', 'logs', 'language_server.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const matches = [...content.matchAll(/Language server listening on random port at (\d+) for HTTP/g)];
      if (matches.length > 0) port = matches[matches.length - 1][1];
    }
  } catch { /* ignore */ }

  // Validate log port is actually open; fall back to /proc/net/tcp listeners later if needed.
  if (port && token) {
    env.ANTIGRAVITY_LS_ADDRESS = `localhost:${port}`;
    env.ANTIGRAVITY_CSRF_TOKEN = token;
    return env;
  }

  try {
    for (const file of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(file)) continue;
      try {
        const envContent = fs.readFileSync(`/proc/${file}/environ`, 'utf-8');
        const parts = envContent.split('\0');
        const addrVar = parts.find((p) => p.startsWith('ANTIGRAVITY_LS_ADDRESS='));
        const tokenVar = parts.find((p) => p.startsWith('ANTIGRAVITY_CSRF_TOKEN='));
        if (addrVar && tokenVar) {
          env.ANTIGRAVITY_LS_ADDRESS = addrVar.slice('ANTIGRAVITY_LS_ADDRESS='.length);
          env.ANTIGRAVITY_CSRF_TOKEN = tokenVar.slice('ANTIGRAVITY_CSRF_TOKEN='.length);
          break;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return env;
}

export function agyToolFriendlyName(name: string): string {
  const n = (name || '').trim();
  const map: Record<string, string> = {
    list_dir: 'List Directory',
    list_directory: 'List Directory',
    view_file: 'View File',
    write_to_file: 'Write File',
    replace_file_content: 'Edit File',
    multi_replace_file_content: 'Edit File',
    grep_search: 'Search Workspace',
    run_command: 'Bash',
    search_web: 'Web Search',
    code_action: 'Code Action',
    generate_image: 'Generate Image',
    invoke_subagent: 'Subagent',
    ask_question: 'Ask Question',
    read_browser_page: 'Browser',
    open_browser_url: 'Browser',
  };
  return map[n] || map[n.toLowerCase()] || n || 'Tool';
}

export function agyPreviewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  if (typeof input !== 'object') return String(input).slice(0, 200);
  const rec = input as Record<string, unknown>;
  for (const key of ['Command', 'command', 'DirectoryPath', 'FilePath', 'file_path', 'path', 'Query', 'pattern', 'Url', 'url']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) {
      // agentapi sometimes double-quotes JSON string values
      return v.replace(/^"+|"+$/g, '').slice(0, 200);
    }
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return '';
  }
}

export function agyNormalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const unquoted = v.replace(/^"+|"+$/g, '');
      out[k] = unquoted;
    } else {
      out[k] = v;
    }
  }
  return out;
}

