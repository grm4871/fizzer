/** Small, DOM-free predicates shared by ChatView and its focused tests. */
import type { ChatMessage } from '../chat/types';

export function isAtScrollBottom(element: HTMLElement, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function shouldSnapToRecentOnSend(element: HTMLElement, threshold = 600) {
  return isAtScrollBottom(element, threshold);
}

export function isPendingAgentRunShell(message: ChatMessage | undefined) {
  if (!message) return false;
  const belongsToAgent = Boolean(message.agentId || message.registrationId || message.runId != null);
  return belongsToAgent && (message.status === 'sending' || message.status === 'running');
}

export function shouldDetachStickyForWheel(deltaY: number) {
  return deltaY < 0;
}

export function shouldDetachStickyForTouch(startY: number | null, currentY: number | null) {
  return startY != null && currentY != null && currentY > startY + 4;
}
