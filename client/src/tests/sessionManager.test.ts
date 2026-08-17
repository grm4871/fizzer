import { describe, expect, it } from 'vitest';
import {
  buildSessionTimeline,
  sessionConsoleText,
  sessionRequestText,
  type RunEvent,
} from '../components/SessionManager';

function runEvent(
  id: number,
  type: string,
  payload: unknown,
): RunEvent {
  return {
    id,
    seq: id,
    type,
    payload_json: JSON.stringify(payload),
    ts: `2026-07-30T21:00:0${id}Z`,
  };
}

describe('session manager prompt presentation', () => {
  it('shows the actual request instead of the agent header and injected context', () => {
    const prompt = [
      'You are Sol (@sol) in #cascade-dev, replying to asdfasdf. Complete requested work.',
      'fix the session manager',
      '[Context: Cascade capability policy and a very long workspace injection.]',
    ].join('\n\n');

    expect(sessionRequestText(prompt)).toBe('fix the session manager');
  });

  it('preserves ordinary note-run prompts', () => {
    expect(sessionRequestText('Refactor the note toolbar.')).toBe('Refactor the note toolbar.');
  });
});

describe('session manager activity folding', () => {
  it('coalesces token deltas and keeps tool activity readable', () => {
    const events = [
      runEvent(1, 'status', { status: 'running' }),
      runEvent(2, 'text', { message: { content: [{ type: 'thinking', thinking: 'Inspecting ' }] } }),
      runEvent(3, 'text', { message: { content: [{ type: 'thinking', thinking: 'the component.' }] } }),
      runEvent(4, 'text', { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'App.tsx' } }] } }),
      runEvent(5, 'text', { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'SessionManager.tsx' } }] } }),
      runEvent(6, 'text', { message: { content: [{ type: 'text', text: 'Fixed ' }] } }),
      runEvent(7, 'text', { message: { content: [{ type: 'text', text: 'and verified.' }] } }),
    ];

    const timeline = buildSessionTimeline(events);
    expect(timeline.map((item) => item.kind)).toEqual(['status', 'thinking', 'tool', 'response']);
    expect(timeline[1].text).toBe('Inspecting the component.');
    expect(timeline[2].text).toContain('SessionManager.tsx');
    expect(timeline[3].text).toBe('Fixed and verified.');
  });

  it('keeps raw harness output in the console and strips terminal escapes', () => {
    const events = [
      runEvent(1, 'harness', { data: '\u001b[32m✓ build\u001b[0m\r\n' }),
      runEvent(2, 'harness', { data: 'runtime ok\n' }),
    ];
    expect(sessionConsoleText(events)).toBe('✓ build\r\nruntime ok');
  });
});
