import { describe, expect, it } from 'vitest';
import {
  buildHarnessActivity,
  hasRunActivity,
  summarizeActivity,
} from '../chat/harnessActivity';
import { appendChatRunBlocks, normalizeChatRunBlocks } from '../chat/runBlocks';
import type { ChatMessage } from '../components/ChatView';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    channelId: 'c1',
    author: 'Agent',
    body: '',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('normalizeChatRunBlocks', () => {
  it('keeps tool_use and tool_result blocks', () => {
    const blocks = normalizeChatRunBlocks([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash' });
    expect(blocks[2]).toMatchObject({ type: 'tool_result', toolUseId: 't1', content: 'ok' });
  });

  it('merges tool_use by id', () => {
    let blocks = normalizeChatRunBlocks([
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ]);
    blocks = appendChatRunBlocks(blocks, normalizeChatRunBlocks([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
    ]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].input).toEqual({ command: 'pwd' });
  });
});

describe('buildHarnessActivity', () => {
  it('builds timeline from structured blocks', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [
        { type: 'thinking', text: 'plan a' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cascade-chat history' } },
        { type: 'tool_result', toolUseId: 't1', content: '[]', isError: false },
      ],
    }));
    expect(activity.stats.hasThinking).toBe(true);
    expect(activity.stats.toolCount).toBe(1);
    expect(activity.items.some((i) => i.kind === 'tool' && i.title === 'Bash')).toBe(true);
    const tool = activity.items.find((i) => i.kind === 'tool')?.tool;
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe('[]');
  });

  it('parses cascade-stats and meta from harness log', () => {
    const activity = buildHarnessActivity(msg({
      harnessLog: [
        '# claude-code claude-sonnet-4 · /home/jt/proj',
        '# cascade-stats {"inputTokens":1200,"outputTokens":80,"totalCostUsd":0.012,"durationMs":4500}',
        '# exit 0',
      ].join('\n'),
    }));
    expect(activity.stats.model).toBe('claude-sonnet-4');
    expect(activity.stats.cwd).toContain('/home/jt/proj');
    expect(activity.stats.inputTokens).toBe(1200);
    expect(activity.stats.outputTokens).toBe(80);
    expect(activity.stats.totalCostUsd).toBe(0.012);
    expect(activity.stats.durationMs).toBe(4500);
  });

  it('falls back to codex JSONL tools when blocks are empty', () => {
    const activity = buildHarnessActivity(msg({
      harnessLog: JSON.stringify({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'echo hi' },
      }) + '\n' + JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi', exit_code: 0 },
      }),
    }));
    expect(activity.stats.toolCount).toBe(1);
    expect(activity.items[0]?.title).toBe('Bash');
  });

  it('keeps activity for empty-body cascade-chat shells', () => {
    const m = msg({
      agentId: 'claude-code',
      runId: 9,
      body: '',
      blocks: [{ type: 'thinking', text: 'still here' }],
    });
    expect(hasRunActivity(m)).toBe(true);
    expect(summarizeActivity(buildHarnessActivity(m), false)).toMatch(/thought/i);
  });
});
