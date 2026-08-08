import type { DesktopRunnerHealth } from './components/ChatView';

export type DesktopExperienceAction = 'download';

export type DesktopExperience = {
  tone: 'setup';
  title: string;
  detail: string;
  action: DesktopExperienceAction;
  actionLabel: string;
};

/**
 * Translate the runner socket's technical state into the one next action a
 * person can safely take. Keeping this separate from App makes the first-run
 * and recovery contract explicit (and testable) for web and Electron alike.
 */
export function describeDesktopExperience(
  inDesktopApp: boolean,
  health: DesktopRunnerHealth | null,
): DesktopExperience | null {
  // Runner state belongs in the agent/session surfaces inside desktop. In
  // particular, null means "not checked yet" and an offline snapshot can be a
  // normal socket reconnect; neither should shift the whole workspace.
  if (inDesktopApp || !health || health.online) return null;
  return {
    tone: 'setup',
    title: 'Run agents in Cascade desktop',
    detail: 'The desktop app runs agents with the local CLI account you choose; provider usage follows that account’s plan.',
    action: 'download',
    actionLabel: 'Get desktop',
  };
}
