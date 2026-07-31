export type SessionTurn = {
  preceding: Promise<void> | undefined;
  release: () => void;
};

/**
 * Serialize top-level prompts for one backing CLI session.
 *
 * The returned turn is installed as the new tail immediately, so later pings
 * wait for it even while the current caller is still waiting on its predecessor.
 */
export function enqueueSessionTurn(
  tails: Map<string, Promise<void>>,
  key: string,
): SessionTurn {
  const preceding = tails.get(key);
  let resolveTurn = () => {};
  const turn = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  tails.set(key, turn);

  let released = false;
  return {
    preceding,
    release: () => {
      if (released) return;
      released = true;
      resolveTurn();
      if (tails.get(key) === turn) tails.delete(key);
    },
  };
}
