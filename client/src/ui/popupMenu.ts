import { useEffect, useLayoutEffect, useRef } from 'react';

/** Gap kept between a popup menu and the viewport edge. */
const VIEWPORT_MARGIN = 8;

const ITEM_SELECTOR = 'button:not(:disabled)';

/**
 * Shared behaviour for the pointer-positioned popup menus (sidebar tree, tab
 * strip, chat message). Call sites render the menu at the raw pointer
 * coordinates and this hook then:
 *
 * - nudges it back inside the viewport — a menu opened near the bottom or right
 *   edge (routine on a phone) otherwise renders partly off-screen with no way
 *   to reach the clipped items;
 * - moves focus into the menu and wires Arrow/Home/End navigation, so the
 *   `:focus-visible` row styling is actually reachable from the keyboard;
 * - hands focus back to whatever had it when the menu closes.
 *
 * `openKey` must change whenever the menu opens (null/undefined = closed);
 * `contentKey` when the same menu swaps its item list (e.g. a submenu).
 */
export function usePopupMenu<T extends HTMLElement>(openKey: unknown, contentKey?: unknown) {
  const ref = useRef<T | null>(null);

  // Layout effect: measure and correct before paint so the menu never flashes
  // in the wrong place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (openKey == null || !el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.top, window.innerHeight - rect.height - VIEWPORT_MARGIN),
    );
    if (left !== rect.left) el.style.left = `${left}px`;
    if (top !== rect.top) el.style.top = `${top}px`;
  }, [openKey, contentKey]);

  useEffect(() => {
    const el = ref.current;
    if (openKey == null || !el) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    const items = () => Array.from(el.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    items()[0]?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      const list = items();
      if (!list.length) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      let next: number | null = null;
      if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length;
      else if (event.key === 'ArrowUp') next = current <= 0 ? list.length - 1 : current - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = list.length - 1;
      if (next === null) return;
      event.preventDefault();
      list[next]?.focus({ preventScroll: true });
    };

    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      // Only take focus back if the menu still holds it; an item that opened a
      // rename input or the composer has already moved focus on purpose.
      if (restoreTo?.isConnected && el.contains(document.activeElement)) {
        restoreTo.focus({ preventScroll: true });
      }
    };
  }, [openKey, contentKey]);

  return ref;
}
