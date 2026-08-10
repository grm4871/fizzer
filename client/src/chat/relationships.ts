export const CHAT_RELATIONSHIPS = [
  'builds_on',
  'review_request',
  'question',
  'contradiction',
  'decision',
] as const;

export type ChatRelationship = typeof CHAT_RELATIONSHIPS[number];

export const CHAT_RELATIONSHIP_LABELS: Record<ChatRelationship, string> = {
  builds_on: 'Builds on',
  review_request: 'Review request',
  question: 'Question',
  contradiction: 'Contradiction',
  decision: 'Decision',
};

export const CHAT_RELATIONSHIP_INSTRUCTIONS: Record<ChatRelationship, string> = {
  builds_on: 'Build on this output and carry it forward.',
  review_request: 'Review this output. Check its claims and identify concrete issues or improvements.',
  question: 'Answer the question raised by this output.',
  contradiction: 'Challenge this output. Identify disagreements and support them with evidence.',
  decision: 'Make a decision based on this output and explain the deciding evidence.',
};

export function relationshipPromptLabel(relationship: ChatRelationship | undefined, nested = false): string {
  if (!relationship) return nested ? '…which was itself replying to' : 'Replying to';
  const labels: Record<ChatRelationship, string> = {
    builds_on: nested ? '…which built on' : 'Building on',
    review_request: nested ? '…which requested review of' : 'Review requested for',
    question: nested ? '…which asked about' : 'Question about',
    contradiction: nested ? '…which challenged' : 'Challenging',
    decision: nested ? '…which decided about' : 'Decision about',
  };
  return labels[relationship];
}
