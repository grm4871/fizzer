import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../components/ChatView';
import {
  isForcedWorkTraceLine,
  isSteeringContinuationMessage,
  isWorkTraceMessage,
  partitionWorkRun,
  segmentTranscript,
  humanizeActivityLine,
  workTracePreview,
  workTraceDecals,
  workTracePhase,
  workTracePeek,
  workTraceStatusLabel,
  workTraceSummary,
} from '../chat/workTrace';

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'author' | 'body'>): ChatMessage {
  return {
    channelId: 'ch',
    createdAt: '2026-08-03T00:00:00.000Z',
    ...partial,
  };
}

describe('workTrace', () => {
  it('recognizes the durable steering sentinel without exposing it as prose', () => {
    expect(isSteeringContinuationMessage(msg({
      id: 'steered', author: 'Sol', body: 'Steered into the continuation below.', status: 'canceled',
    }))).toBe(true);
    expect(isSteeringContinuationMessage(msg({
      id: 'cancel', author: 'Sol', body: 'Run canceled by user.', status: 'canceled',
    }))).toBe(false);
  });

  it('labels steering cancels as steer, not blocked', () => {
    const steered = msg({
      id: 'steered', author: 'Sol', body: 'Steered into the continuation below.', status: 'canceled', agentId: 'codex',
    });
    expect(workTracePhase(steered)).toBe('steering');
    expect(workTraceStatusLabel(steered)).toBe('steered');
    expect(workTracePhase(msg({
      id: 'hard-cancel', author: 'Sol', body: 'Run canceled by user.', status: 'canceled', agentId: 'codex',
    }))).toBe('blocked');
  });
  it('classifies agents, mission wakes, and humans', () => {
    expect(isWorkTraceMessage(msg({ id: '1', author: 'jt', body: 'hi' }))).toBe(false);
    expect(isWorkTraceMessage(msg({ id: '2', author: 'Sol', body: 'ok', agentId: 'codex' }))).toBe(true);
    expect(isWorkTraceMessage(msg({ id: 'sys-mission-abc-wake', author: 'Cascade', body: 'review' }))).toBe(true);
    expect(isWorkTraceMessage(msg({ id: '3', author: 'Sol', body: 'x' }), new Set(['Sol']))).toBe(true);
    expect(isForcedWorkTraceLine(msg({ id: 't', author: 'Sol', body: 'x', missionTaskId: 'task-1' }))).toBe(true);
  });

  it('keeps a single ordinary agent reply as a full bubble', () => {
    const reply = msg({ id: 'a1', author: 'Sol', body: 'Done.', agentId: 'codex' });
    expect(partitionWorkRun([reply])).toEqual({ trace: [], full: [reply] });
  });

  it('does not fold a later same-author turn into an earlier conversation burst', () => {
    const first = msg({ id: 'h1', author: 'diego', body: 'It is duplicated.' });
    const later = msg({
      id: 'h2', author: 'diego', body: 'On the frontend.',
      createdAt: '2026-08-03T00:02:00.000Z',
    });
    const segments = segmentTranscript([first, later]);
    expect(segments).toHaveLength(2);
  });

  it('hides a lone long delegated response behind the work dot', () => {
    const workerEssay = msg({
      id: 'worker-essay',
      author: 'Sonnet',
      body: '# Audit\n\n' + 'Detailed evidence for the coordinator. '.repeat(80),
      agentId: 'claude',
      missionTaskId: 'task-essay',
    });
    expect(partitionWorkRun([workerEssay])).toEqual({ trace: [workerEssay], full: [] });
  });

  it('collapses intermediates and keeps the final non-worker answer full', () => {
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Checking…', agentId: 'codex' });
    const final = msg({ id: 'a2', author: 'Sol', body: 'Fixed root cause.', agentId: 'codex' });
    const { trace, full } = partitionWorkRun([mid, final]);
    expect(trace).toEqual([mid]);
    expect(full).toEqual([final]);
  });

  it('keeps worker and system messages in the compact stream', () => {
    const wake = msg({ id: 'sys-mission-1-wake', author: 'Cascade', body: '@sol review' });
    const worker = msg({
      id: 'a1',
      author: 'Terra',
      body: 'Deploy green.',
      agentId: 'codex',
      missionTaskId: 'task-1',
    });
    const final = msg({ id: 'a2', author: 'Sol', body: 'All clear.', agentId: 'codex' });
    const { trace, full } = partitionWorkRun([wake, worker, final]);
    expect(trace.map((m) => m.id)).toEqual(['sys-mission-1-wake', 'a1']);
    expect(full.map((m) => m.id)).toEqual(['a2']);
  });

  it('keeps live running shells inside the compact trace', () => {
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Thinking…', agentId: 'codex' });
    const live = msg({ id: 'a2', author: 'Terra', body: 'Thinking…', agentId: 'codex', status: 'running' });
    const { trace, full } = partitionWorkRun([mid, live]);
    expect(trace).toEqual([mid, live]);
    expect(full).toEqual([]);
  });

  it('never hides media inside the compact trace', () => {
    const progress = msg({ id: 'a1', author: 'Sol', body: 'Checking…', agentId: 'codex' });
    const artifact = msg({
      id: 'a2', author: 'Terra', body: 'Screenshot evidence.', agentId: 'codex',
      attachments: [{ name: 'proof.png', media_type: 'image/png', url: '/proof.png' }],
    });
    const { trace, full } = partitionWorkRun([progress, artifact]);
    expect(trace).toEqual([progress]);
    expect(full).toEqual([artifact]);
  });

  it('segments human turns around work runs', () => {
    const human = msg({ id: 'h1', author: 'jt', body: 'fix this' });
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Looking…', agentId: 'codex' });
    const final = msg({ id: 'a2', author: 'Sol', body: 'Done.', agentId: 'codex' });
    const segments = segmentTranscript([human, mid, final]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: 'group' });
    expect(segments[1]).toMatchObject({
      kind: 'work',
      id: 'a1',
      trace: [mid],
    });
    if (segments[1].kind === 'work') expect(segments[1].fullGroups).toHaveLength(0);
    if (segments[1].kind === 'work') expect(segments[1].updateGroups).toEqual([{ messages: [final] }]);
  });

  it('nests a system wake in its persisted empty agent carrier', () => {
    const carrier = msg({
      id: 'agent-trace-mission-1-wake', author: 'Terra', body: '', agentId: 'codex', registrationId: 'terra-reg',
    });
    const wake = msg({ id: 'sys-mission-mission-1-wake', author: 'Cascade', body: '@terra review' });
    const segments = segmentTranscript([carrier, wake]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: 'work', carrier, trace: [wake] });
  });

  it('keeps one agent carrier and compact trail around full-weight artifacts', () => {
    const before = msg({ id: 'a1', author: 'Sol', body: 'Before', agentId: 'codex' });
    const artifact = msg({
      id: 'a2', author: 'Terra', body: 'Evidence', agentId: 'codex',
      attachments: [{ name: 'proof.png', media_type: 'image/png', url: '/proof.png' }],
    });
    const after = msg({
      id: 'a3', author: 'Terra', body: 'After', agentId: 'codex', missionTaskId: 'task-1',
    });
    const final = msg({ id: 'a4', author: 'Sol', body: 'Done', agentId: 'codex' });
    const segments = segmentTranscript([before, artifact, after, final]);
    expect(segments.map((segment) => segment.kind)).toEqual(['work']);
    if (segments[0].kind === 'work') {
      expect(segments[0].trace.map((message) => message.id)).toEqual(['a1', 'a3']);
      expect(segments[0].fullGroups.flatMap((group) => group.messages.map((message) => message.id))).toEqual(['a2']);
      expect(segments[0].updateGroups.flatMap((group) => group.messages.map((message) => message.id))).toEqual(['a4']);
    }
  });

  it('keeps mission work and its final user-facing update in one segment', () => {
    const acknowledgement = msg({ id: 'a1', author: 'Sol', body: 'I am fixing it.', agentId: 'codex', registrationId: 'sol' });
    const mission = msg({
      id: 'm1', author: 'Cascade', body: 'Fix it durably.',
      mission: { id: 'mission-1', title: 'Fix it', status: 'active', coordinator: 'sol', tasks: [] },
    });
    const worker = msg({ id: 'w1', author: 'Sol', body: 'Tests pass.', agentId: 'codex', registrationId: 'sol', missionTaskId: 'task-1' });
    const shipped = msg({ id: 'a2', author: 'Sol', body: 'Shipped.', agentId: 'codex', registrationId: 'sol' });
    const segments = segmentTranscript([acknowledgement, mission, worker, shipped]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: 'work' });
    if (segments[0].kind === 'work') {
      expect(segments[0].trace.map((message) => message.id)).toEqual(['a1', 'w1']);
      expect(segments[0].fullGroups.flatMap((group) => group.messages.map((message) => message.id))).toEqual(['m1']);
      expect(segments[0].updateGroups.flatMap((group) => group.messages.map((message) => message.id))).toEqual(['a2']);
    }
  });

  it('flattens coordinator progress when later worker activity follows', () => {
    const coordinator = msg({
      id: 'a1', author: 'Sol', body: 'Here is the answer.', agentId: 'codex', registrationId: 'sol-reg',
    });
    const laterWorker = msg({
      id: 'a2', author: 'Terra', body: 'Still checking.', agentId: 'codex', missionTaskId: 'task-1',
    });
    const segments = segmentTranscript([coordinator, laterWorker]);
    expect(segments.map((segment) => segment.kind)).toEqual(['work']);
    if (segments[0].kind === 'work') expect(segments[0].trace).toEqual([coordinator, laterWorker]);
  });

  it('derives a compact ordered workflow decal trail', () => {
    const trace = [
      msg({ id: '1', author: 'Sol', body: 'Queued for Terra', status: 'sending', missionTaskId: 't1' }),
      msg({ id: '2', author: 'Terra', body: 'Running regression tests', status: 'running', missionTaskId: 't1' }),
      msg({ id: '3', author: 'Sol', body: 'Reconciling evidence for review', status: 'running' }),
      msg({ id: '4', author: 'Sol', body: 'Deploying production', status: 'running' }),
      msg({ id: '5', author: 'Sol', body: 'Done' }),
    ];
    expect(trace.map(workTracePhase)).toEqual(['routing', 'testing', 'reviewing', 'deploying', 'complete']);
    expect(workTraceDecals(trace).map((decal) => decal.label)).toEqual(['route', 'test', 'review', 'deploy', 'complete']);
  });

  it('previews and summarizes compactly', () => {
    // Newest useful line wins (live harness tails grow downward).
    expect(workTracePreview('line one\nline two')).toBe('line two');
    expect(workTracePreview('x'.repeat(200)).endsWith('…')).toBe(true);
    const trace = [
      msg({ id: '1', author: 'Sol', body: 'a', agentId: 'codex' }),
      msg({ id: '2', author: 'Terra', body: 'b', agentId: 'codex' }),
    ];
    expect(workTraceSummary(trace)).toContain('2 steps');
    expect(workTraceSummary(trace)).toContain('Sol');
  });

  it('humanizes protocol JSONL instead of dumping raw objects', () => {
    expect(humanizeActivityLine('{"type":"thread.started","thread_id":"abc"}')).toBe('session started');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'rg "mission" client/src' },
    }))).toBe('Bash rg "mission" client/src');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'reasoning', text: '' },
    }))).toBe('thinking…');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', path: '/home/jt/Desktop/cascade/client/src/App.tsx' },
    }))).toBe('edited src/App.tsx');
    // Never surface the full JSON blob.
    expect(workTracePreview('{"type":"thread.started","thread_id":"abc"}\n{"type":"item.started","item":{"type":"reasoning"}}'))
      .toBe('thinking…');
  });

  it('builds a collapsed mission peek from the live step', () => {
    const peek = workTracePeek([
      msg({ id: '1', author: 'Sol', body: 'Queued', status: 'sending', missionTaskId: 't1' }),
      msg({
        id: '2',
        author: 'Terra',
        body: 'Thinking…',
        status: 'running',
        harnessLog: '{"type":"thread.started","thread_id":"x"}\nBash rg "mission" client/src',
      }),
    ]);
    expect(peek).toMatchObject({
      live: true,
      author: 'Terra',
      label: 'Bash rg "mission" client/src',
      phase: 'working',
    });
    expect(peek?.summary).toContain('live');
    expect(peek?.decals.at(-1)?.label).toBe('work');
  });
});
