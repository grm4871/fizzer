import { describe, expect, it } from 'vitest';
import { parseAndroidCodexOutputLine } from '../androidLocalCodex';

describe('Android local Codex stream', () => {
  it('captures the resumable Codex thread id', () => {
    expect(parseAndroidCodexOutputLine('{"type":"thread.started","thread_id":"thread-1"}'))
      .toEqual({ sessionId: 'thread-1' });
  });

  it('promotes only completed agent messages into chat', () => {
    expect(parseAndroidCodexOutputLine('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}'))
      .toEqual({ answer: 'hello' });
    expect(parseAndroidCodexOutputLine('{"type":"item.completed","item":{"type":"reasoning","text":"private"}}'))
      .toEqual({});
    expect(parseAndroidCodexOutputLine('diagnostic output')).toEqual({});
  });
});
