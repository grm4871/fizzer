import { describe, expect, it } from 'vitest';
import { reconcileCancelAcknowledgement } from '../desktopRunnerHost';

describe('desktop runner cancellation acknowledgement', () => {
  it('is idempotent once the run is already settled locally', async () => {
    expect(await reconcileCancelAcknowledgement(false, 42, new Set(), 10)).toBe(true);
  });

  it('accepts the child-cleanup race when the terminal event arrives', async () => {
    const active = new Set([42]);
    setTimeout(() => active.delete(42), 5);
    expect(await reconcileCancelAcknowledgement(false, 42, active, 100)).toBe(true);
  });

  it('still refuses a genuinely active run that did not stop', async () => {
    expect(await reconcileCancelAcknowledgement(false, 42, new Set([42]), 10)).toBe(false);
  });
});
