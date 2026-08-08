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
    expect(experience).toMatchObject({ tone: 'setup', action: 'download', actionLabel: 'Get desktop' });
    expect(experience?.detail).toMatch(/provider usage follows that account/i);
  });

  it('does not flash a handoff while runner health is still unknown', () => {
    expect(describeDesktopExperience(false, null)).toBeNull();
  });

  it('does not ask for a desktop install when the same account has a runner online', () => {
    expect(describeDesktopExperience(false, { ...offline, online: true })).toBeNull();
  });

  it('keeps runner connection and run errors out of global desktop chrome', () => {
    expect(describeDesktopExperience(true, null)).toBeNull();
    expect(describeDesktopExperience(true, offline)).toBeNull();
    expect(describeDesktopExperience(true, { ...offline, lastError: 'Restricted credential expired.' })).toBeNull();
  });
});
