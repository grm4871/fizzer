import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export async function stopChildProcess(child, graceMs = 750) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit').catch(() => []);
  child.kill('SIGTERM');
  await Promise.race([exited, delay(graceMs)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(graceMs)]);
  }
}
