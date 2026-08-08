import { describe, expect, it } from 'vitest';
import { LatestRunnerSetup, reconcileCancelAcknowledgement } from '../desktopRunnerHost';

describe('desktop runner credential setup', () => {
  it('coalesces repeated setup for the same login', async () => {
    const setup = new LatestRunnerSetup();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = async () => {
      calls += 1;
      await gate;
    };

    const first = setup.ensure('same-login', task);
    const second = setup.ensure('same-login', task);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(second).toBe(first);
    release();
    await first;
  });

  it('invalidates a late setup completion during logout', async () => {
    const setup = new LatestRunnerSetup();
    let release!: () => void;
    let activated = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = setup.ensure('login', async (isCurrent) => {
      await gate;
      activated = isCurrent();
    });

    setup.invalidate();
    release();
    await pending;
    expect(activated).toBe(false);
  });

  it('supersedes an older login when credentials change', async () => {
    const setup = new LatestRunnerSetup();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldCurrent = true;
    let newCurrent = false;
    const old = setup.ensure('old', async (isCurrent) => {
      await oldGate;
      oldCurrent = isCurrent();
    });
    const next = setup.ensure('new', async (isCurrent) => {
      newCurrent = isCurrent();
    });
    releaseOld();
    await Promise.all([old, next]);
    expect(oldCurrent).toBe(false);
    expect(newCurrent).toBe(true);
  });
});

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
