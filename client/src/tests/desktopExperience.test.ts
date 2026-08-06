import { describe, expect, it } from 'vitest';
import { describeDesktopExperience } from '../desktopExperience';

const offline = {
  online: false,
  activeRuns: 0,
  lastError: null,
  lastErrorAt: null,
  lastSeenAt: null,
  models: null,
  planUsage: null,
};

describe('desktop beta experience', () => {
  it('gives a web invitee a concrete desktop handoff without claiming free provider use', () => {
    const experience = describeDesktopExperience(false, offline);
    expect(experience).toMatchObject({ tone: 'setup', action: 'download', actionLabel: 'Get desktop app' });
    expect(experience?.detail).toMatch(/provider usage follows that account/i);
  });

  it('does not ask for a desktop install when the same account has a runner online', () => {
    expect(describeDesktopExperience(false, { ...offline, online: true })).toBeNull();
  });

  it('turns a desktop runner failure into an in-place repair action', () => {
    const experience = describeDesktopExperience(true, { ...offline, lastError: 'Restricted credential expired.' });
    expect(experience).toMatchObject({ tone: 'repair', action: 'reload', detail: 'Restricted credential expired.' });
  });

  it('keeps a fresh desktop launch honest while health is still pending', () => {
    expect(describeDesktopExperience(true, null)).toMatchObject({ tone: 'connecting', action: 'reload' });
  });
});
