import { describe, expect, it } from 'vitest';
import {
  buildDocumentationPrompt,
  reduceDocumentationEvent,
  type DocumentationAssistantTurn,
} from '../documentationAssistant';

describe('documentation assistant prompt context', () => {
  it('includes the guide, current question, and bounded recent history', () => {
    const history: DocumentationAssistantTurn[] = [
      { id: 'u1', role: 'user', body: 'old question', status: 'completed' },
      { id: 'a1', role: 'assistant', body: 'old answer', status: 'completed' },
    ];
    const prompt = buildDocumentationPrompt('# Guide\nUse notes.', 'How do notes work?', history);

    expect(prompt).toContain('<fizzer-guide>\n# Guide\nUse notes.\n</fizzer-guide>');
    expect(prompt).toContain('How do notes work?');
    expect(prompt).toContain('old question');
    expect(prompt).toContain('Do not inspect or modify files');
  });

  it('limits history by turn count and character budget', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      body: `${index}:${'x'.repeat(2_000)}`,
      status: 'completed' as const,
    }));
    const prompt = buildDocumentationPrompt('guide', 'question', history);

    expect(prompt).not.toContain('0:');
    expect(prompt).toContain('9:');
    expect(prompt.length).toBeLessThan(7_000);
  });
});

describe('documentation assistant run events', () => {
  it('accumulates visible text and ignores reasoning-only events', () => {
    const initial = { answer: '', status: 'queued' as const, seenSeqs: new Set<number>() };
    const hidden = reduceDocumentationEvent(initial, {
      seq: 1,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: false, message: { content: 'hidden' } }),
    });
    const visible = reduceDocumentationEvent(hidden, {
      seq: 2,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Answer' }] } }),
    });

    expect(hidden.answer).toBe('');
    expect(visible.answer).toBe('Answer');
    expect(visible.status).toBe('running');
  });

  it('deduplicates replayed events and settles terminal status', () => {
    const initial = { answer: '', status: 'running' as const, seenSeqs: new Set<number>() };
    const first = reduceDocumentationEvent(initial, {
      seq: 4,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Done' }] } }),
    });
    const duplicate = reduceDocumentationEvent(first, {
      seq: 4,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Done' }] } }),
    });
    const completed = reduceDocumentationEvent(duplicate, {
      seq: 5,
      type: 'status',
      payload_json: JSON.stringify({ status: 'completed', summary: 'Finished' }),
    });

    expect(duplicate.answer).toBe('Done');
    expect(completed.status).toBe('completed');
    expect(completed.terminal).toBe('Finished');
  });
});
