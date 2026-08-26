const SCROLL_PIN_PX = 48;
const EDGE_PX = 2;

export function isPinnedToBottom(el: HTMLElement, slack = SCROLL_PIN_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function scrollToBottom(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** Scroll once after layout; repeated updates naturally coalesce before paint. */
export function scrollToBottomSoon(el: HTMLElement | null | undefined) {
  if (!el) return;
  requestAnimationFrame(() => scrollToBottom(el));
}

export { EDGE_PX };
