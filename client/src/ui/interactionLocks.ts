/**
 * Body-level drag locks (cursor / user-select) and pointer-capture recovery.
 *
 * Resize/swipe handlers that only clean up on `mouseup` leave the UI unclickable
 * when the end event is lost (window blur, Electron focus steal, element unmount
 * mid-capture). Restart used to be the only recovery — these helpers clear the
 * lock on blur/visibility and expose a safe release path.
 */

let activeLocks = 0;

export function acquireInteractionLock(opts?: { cursor?: string }): void {
  activeLocks += 1;
  if (opts?.cursor) document.body.style.cursor = opts.cursor;
  document.body.style.userSelect = 'none';
  (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';
}

export function releaseInteractionLock(): void {
  activeLocks = Math.max(0, activeLocks - 1);
  if (activeLocks > 0) return;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = '';
}

/** Force-clear regardless of nested lock count (recovery / unmount safety). */
export function forceClearInteractionLocks(): void {
  activeLocks = 0;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = '';
}

/**
 * Attach window listeners for a drag gesture that must end even if mouseup is lost.
 * Returns a disposer that also clears the lock.
 */
export function bindDragGesture(handlers: {
  onMove: (event: PointerEvent | MouseEvent) => void;
  onEnd: () => void;
}): () => void {
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    window.removeEventListener('mouseup', onEnd);
    window.removeEventListener('blur', onEnd);
    document.removeEventListener('visibilitychange', onVisibility);
    handlers.onEnd();
  };
  const onPointerMove = (event: PointerEvent) => handlers.onMove(event);
  const onEnd = () => finish();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') finish();
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
  // Fallback for environments that still emit mouse-only end events.
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('blur', onEnd);
  document.addEventListener('visibilitychange', onVisibility);

  return finish;
}

/** Install app-wide recovery so a stuck lock never requires a full restart. */
export function installInteractionLockRecovery(): () => void {
  const recover = () => forceClearInteractionLocks();
  window.addEventListener('blur', recover);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') recover();
  });
  // Soft recovery: Escape always clears body drag locks (does not dismiss menus).
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') recover();
  };
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('blur', recover);
    window.removeEventListener('keydown', onKey);
  };
}
