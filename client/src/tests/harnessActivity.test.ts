import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CascadeRunPanel } from '../components/CascadeRunPanel';
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

  it('redacts Claude reasoning from structured and raw activity views', () => {
    const activity = buildHarnessActivity(msg({
      agentId: 'claude-code',
      blocks: [
        { type: 'thinking', text: 'private chain of thought' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ],
      harnessLog: [
        '\x1b[2m# thinking\x1b[0m',
        '\x1b[2mprivate chain of thought\x1b[0m',
        '\x1b[36m▶ Bash\x1b[0m',
        '\x1b[36m{"command":"npm test"}\x1b[0m',
      ].join('\r\n'),
    }));
    expect(activity.thinkingText).toBe('[reasoning hidden]');
    expect(activity.rawLog).toContain('[reasoning hidden]');
    expect(activity.rawLog).not.toContain('private chain of thought');
    expect(activity.rawLog).not.toContain('{"command"');
    expect(activity.items.find((item) => item.kind === 'thinking')?.text).toBe('[reasoning hidden]');
  });

  it('parses cascade-stats and meta from harness log', () => {
    const activity = buildHarnessActivity(msg({
      harnessLog: [
        '# claude-code claude-sonnet-4 · /home/jt/proj',
        '# cascade-stats {"model":"claude-sonnet-4","maxTurns":30}',
        '# cascade-stats {"inputTokens":1200,"outputTokens":80,"totalCostUsd":0.012,"durationMs":4500,"numTurns":4,"contextWindow":200000,"contextUsed":42000}',
        '# cascade-stats {"rateLimitType":"five_hour","rateLimitUtilization":62,"rateLimitResetsAt":"2026-07-10T20:00:00.000Z","rateLimitStatus":"allowed"}',
        '# exit 0',
      ].join('\n'),
    }));
    expect(activity.stats.model).toBe('claude-sonnet-4');
    expect(activity.stats.cwd).toContain('/home/jt/proj');
    expect(activity.stats.inputTokens).toBe(1200);
    expect(activity.stats.outputTokens).toBe(80);
    expect(activity.stats.totalCostUsd).toBe(0.012);
    expect(activity.stats.durationMs).toBe(4500);
    expect(activity.stats.numTurns).toBe(4);
    expect(activity.stats.maxTurns).toBe(30);
    expect(activity.stats.contextWindow).toBe(200000);
    expect(activity.stats.contextUsed).toBe(42000);
    expect(activity.stats.contextPct).toBeCloseTo(21, 0);
    expect(activity.stats.rateLimitType).toBe('five_hour');
    expect(activity.stats.rateLimitUtilization).toBe(62);
  });

  it('builds header chips for tokens, context, and cost', async () => {
    const { buildHeaderStatChips } = await import('../chat/harnessActivity');
    const activity = buildHarnessActivity(msg({
      harnessLog: '# cascade-stats {"inputTokens":1200,"outputTokens":80,"totalCostUsd":0.012,"contextWindow":200000,"contextUsed":42000}\n',
    }));
    const chips = buildHeaderStatChips(activity.stats);
    expect(chips.some((c) => c.id === 'tok' && /tok/.test(c.label))).toBe(true);
    expect(chips.some((c) => c.id === 'ctx' && /ctx/.test(c.label))).toBe(true);
    expect(chips.some((c) => c.id === 'cost' && c.label.startsWith('$'))).toBe(true);
  });

  it('keeps the live Claude summary as compact as Codex', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
      harnessLog: '# cascade-stats {"model":"claude-opus-4-8","rateLimitType":"five_hour","rateLimitUtilization":1,"rateLimitResetsAt":"2026-08-09T07:50:00.000Z","rateLimitStatus":"allowed_warning","overageInUse":true}\n',
    }));
    expect(summarizeActivity(activity, true)).toBe('Bash');
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

  it('keeps launch metadata and recent events when harness logs are large', () => {
    const recentEvent = JSON.stringify({
      type: 'item.completed',
      item: { id: 'recent', type: 'command_execution', command: 'echo recent', aggregated_output: 'ok', exit_code: 0 },
    });
    const activity = buildHarnessActivity(msg({
      harnessLog: `$ codex exec --json\n# cwd /home/jt/project\n${'old output\n'.repeat(9_000)}${recentEvent}\n`,
    }));
    expect(activity.stats.command).toBe('codex exec --json');
    expect(activity.stats.cwd).toBe('/home/jt/project');
    expect(activity.items.some((item) => item.tool?.input === 'echo recent')).toBe(true);
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

describe('CascadeRunPanel raw fallback', () => {
  it('treats a raw CLI launch and heartbeat as live activity', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        harnessLog: [
          '$ akron --grok -z task --yolo',
          '# cwd /home/jt/Desktop/cascade',
          '# Akron --grok still working · 15s without provider output',
        ].join('\n'),
      }),
      onCancelRun: () => {},
      forceOpen: true,
    }));
    expect(markup).toContain('crp-toggle-summary">working');
    expect(markup).toContain('$ akron --grok -z task --yolo');
    expect(markup).toContain('Akron --grok still working');
    expect(markup).not.toContain('waiting for harness stream…');
  });

  it('hides a live unstructured protocol preamble until harness activity arrives', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        harnessLog: '{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}\n',
      }),
      onCancelRun: () => {},
    }));
    expect(markup).toContain('waiting for harness stream…');
    expect(markup).not.toContain('crp-raw-wrap');
  });
});
