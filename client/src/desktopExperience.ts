import type { DesktopRunnerHealth } from './components/ChatView';

export type DesktopExperienceAction = 'download' | 'reload' | null;

export type DesktopExperience = {
  tone: 'setup' | 'connecting' | 'repair';
  title: string;
  detail: string;
  action: DesktopExperienceAction;
  actionLabel?: string;
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
  if (!inDesktopApp) {
    if (health?.online) return null;
    return {
      tone: 'setup',
      title: 'Run agents in Cascade desktop',
      detail: 'Your notes and chats are ready here. The desktop app runs agents with the local CLI account you choose; provider usage follows that account’s plan.',
      action: 'download',
      actionLabel: 'Get desktop app',
    };
  }

  if (health?.online) return null;
  if (health?.lastError) {
    return {
      tone: 'repair',
      title: 'Desktop agent connection needs attention',
      detail: health.lastError,
      action: 'reload',
      actionLabel: 'Reload desktop window',
    };
  }

  return {
    tone: 'connecting',
    title: 'Connecting your desktop agent runner',
    detail: 'Keep this window open while Cascade checks your local agent tools. A window reload is safe if this does not finish.',
    action: 'reload',
    actionLabel: 'Reload window',
  };
}
