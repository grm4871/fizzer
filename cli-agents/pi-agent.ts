/** OMP/Pi JSON event provider adapters. */
import { OMP_BIN, PI_BIN, type AgentEmit, type CliAgentResult, type CliImage, writeTempImages } from './cli-agent-common.js';
import { driveProcess } from './process-driver.js';
import { truncate } from './provider-utils.js';
/**
 * Runs the OMP CLI and translates its JSONL event stream into content blocks.
 */
async function runPiJsonAgent(
  bin: string,
  label: string,
  args: string[],
  cwd: string,
  emit: AgentEmit,
  runId?: number,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  let summary = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  let emittedText = false;
  let lastWasText = false;

  const getToolFriendlyName = (name: string) => {
    if (name === 'read' || name === 'view_file') return 'View File';
    if (name === 'write' || name === 'write_to_file' || name === 'create') return 'Write File';
    if (name === 'edit' || name === 'replace_file_content' || name === 'multi_replace_file_content') return 'Edit File';
    if (name === 'grep' || name === 'grep_search') return 'Search Workspace';
    if (name === 'bash' || name === 'run_command') return 'Bash';
    return name;
  };

  const onLine = (line: string) => {
    try {
      if (line.startsWith('{')) {
        const ev = JSON.parse(line);
        switch (ev.type) {
          case 'session':
            if (ev.id) {
              sessionId = ev.id;
              emit('session', { sessionId });
            }
            break;
          case 'message_update':
            if (ev.assistantMessageEvent) {
              const ame = ev.assistantMessageEvent;
              if (ame.type === 'thinking_delta' && ame.delta) {
                emit('text', { message: { content: [{ type: 'thinking', thinking: ame.delta }] } });
                lastWasText = false;
              } else if (ame.type === 'text_delta' && ame.delta) {
                const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                summary += sep + ame.delta;
                emit('text', { message: { content: [{ type: 'text', text: sep + ame.delta }] } });
                emittedText = true;
                lastWasText = true;
              } else if (ame.type === 'toolcall_end' && ame.toolCall) {
                const tc = ame.toolCall;
                if (tc.id && !emittedTool.has(tc.id)) {
                  emittedTool.add(tc.id);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: tc.id,
                        name: getToolFriendlyName(tc.name),
                        input: tc.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool_execution_start':
            if (ev.toolCallId && !emittedTool.has(ev.toolCallId)) {
              emittedTool.add(ev.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.toolCallId,
                    name: getToolFriendlyName(ev.toolName),
                    input: ev.args || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool_execution_end':
            if (ev.toolCallId) {
              const out = ev.result?.content ?? ev.result?.detailedContent ?? '';
              let contentText = '';
              if (Array.isArray(out)) {
                contentText = out.map(o => typeof o === 'object' && o !== null ? (o.text || JSON.stringify(o)) : String(o)).join('\n');
              } else if (typeof out === 'string') {
                contentText = out;
              } else if (out && typeof out === 'object') {
                contentText = JSON.stringify(out);
              }
              const isError = ev.isError === true || ev.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.toolCallId,
                    content: truncate(String(contentText || out), 8000),
                    is_error: isError
                  }]
                }
              });
              lastWasText = false;
            }
            break;
        }
      }
    } catch {
      // ignore
    }
  };

  const summaryText = await driveProcess(
    bin, args, cwd, onLine, () => summary || '', label, runId, emit, env,
  );
  return { summary: summaryText, sessionId };
}

export async function runOmp(
  prompt: string, cwd: string, emit: AgentEmit, resumeId?: string,
  images: CliImage[] = [], runId?: number, model?: string, env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths, cleanup } = writeTempImages(images);
  const baseArgs = [prompt, '--mode', 'json', '--allow-home', ...paths.map((file) => `@${file}`), ...(model ? ['--model', model] : [])];
  try {
    const result = await runPiJsonAgent(OMP_BIN, 'OMP', resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs, cwd, emit, runId, env);
    return { ...result, sessionId: result.sessionId || resumeId };
  } finally {
    cleanup();
  }
}

export async function runPi(
  prompt: string, cwd: string, emit: AgentEmit, resumeId?: string,
  images: CliImage[] = [], runId?: number, model?: string, env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths, cleanup } = writeTempImages(images);
  const args = [
    '--mode', 'json', '--approve',
    ...(resumeId ? ['--session', resumeId] : []),
    ...(model ? ['--model', model] : []),
    ...paths.map((file) => `@${file}`),
    prompt,
  ];
  try {
    const result = await runPiJsonAgent(PI_BIN, 'Pi', args, cwd, emit, runId, env);
    return { ...result, sessionId: result.sessionId || resumeId };
  } finally {
    cleanup();
  }
}
