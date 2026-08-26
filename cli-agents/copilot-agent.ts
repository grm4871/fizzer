/** Copilot JSON event-stream provider adapter. */
import { COPILOT_BIN, type AgentEmit, type CliAgentResult } from './cli-agent-common.js';
import { driveProcess } from './process-driver.js';
import { truncate } from './provider-utils.js';
/**
 * Runs the Copilot CLI and translates its JSONL event stream into content blocks.
 */
export async function runCopilot(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, model?: string, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const baseArgs = ['-p', prompt, '--output-format', 'json', '--yolo', ...modelArgs];
  const args = resumeId ? ['--session-id', resumeId, ...baseArgs] : baseArgs;

  let summary = '';
  let reasoningText = '';
  let sessionId: string | undefined;
  const emittedTool = new Set<string>();
  // Separate each answer turn from the previous one; reasoning/tool events
  // between turns reset the flag so the next text starts a new paragraph.
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
          case 'assistant.reasoning_delta':
            if (ev.data?.deltaContent) {
              reasoningText += ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.deltaContent }] } });
              lastWasText = false;
            }
            break;
          case 'assistant.reasoning':
            if (ev.data?.content) {
              const hadDeltas = reasoningText.length > 0;
              reasoningText = ev.data.content;
              if (!hadDeltas) {
                emit('text', { message: { content: [{ type: 'thinking', thinking: ev.data.content }] } });
              }
              lastWasText = false;
            }
            break;
          case 'assistant.message_delta':
            if (ev.data?.deltaContent) {
              const sep = (!lastWasText && emittedText) ? '\n\n' : '';
              summary += sep + ev.data.deltaContent;
              emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.deltaContent }] } });
              emittedText = true;
              lastWasText = true;
            }
            break;
          case 'assistant.message':
            if (ev.data) {
              if (ev.data.content) {
                const hadDeltas = summary.length > 0;
                summary = ev.data.content;
                if (!hadDeltas) {
                  const sep = (!lastWasText && emittedText) ? '\n\n' : '';
                  emit('text', { message: { content: [{ type: 'text', text: sep + ev.data.content }] } });
                  emittedText = true;
                  lastWasText = true;
                }
              }
              for (const req of ev.data.toolRequests || []) {
                if (req.toolCallId && !emittedTool.has(req.toolCallId)) {
                  emittedTool.add(req.toolCallId);
                  emit('text', {
                    message: {
                      content: [{
                        type: 'tool_use',
                        id: req.toolCallId,
                        name: getToolFriendlyName(req.name),
                        input: req.arguments || {}
                      }]
                    }
                  });
                  lastWasText = false;
                }
              }
            }
            break;
          case 'tool.execution_start':
            if (ev.data?.toolCallId && !emittedTool.has(ev.data.toolCallId)) {
              emittedTool.add(ev.data.toolCallId);
              emit('text', {
                message: {
                  content: [{
                    type: 'tool_use',
                    id: ev.data.toolCallId,
                    name: getToolFriendlyName(ev.data.toolName),
                    input: ev.data.arguments || {}
                  }]
                }
              });
              lastWasText = false;
            }
            break;
          case 'tool.execution_complete':
            if (ev.data?.toolCallId) {
              const out = ev.data.result?.content ?? ev.data.result?.detailedContent ?? '';
              const isError = ev.data.success === false;
              emit('user', {
                message: {
                  content: [{
                    type: 'tool_result',
                    tool_use_id: ev.data.toolCallId,
                    content: truncate(String(out), 8000),
                    is_error: isError
                  }]
                }
              });
              if (isError) {
                void import('./auto-papercut.mjs')
                  .then((mod) => mod.autoPapercut(String(out), { tool: String(ev.data.toolName || 'tool') }))
                  .catch(() => {});
              }
              lastWasText = false;
            }
            break;
          case 'result':
            if (ev.sessionId) {
              sessionId = ev.sessionId;
              emit('session', { sessionId });
            }
            break;
        }
      } else {
        summary = line;
        emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
      }
    } catch {
      summary = line;
      emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
    }
  };

  const summaryText = await driveProcess(COPILOT_BIN, args, cwd, onLine, () => summary || '', 'Copilot', runId, emit, env);
  return { summary: summaryText, sessionId: sessionId || resumeId };
}

