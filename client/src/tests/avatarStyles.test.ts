import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');

describe('avatar presentation', () => {
  it('keeps every Cascade profile-avatar surface circular', () => {
    for (const selector of [
      '.chat-avatar',
      '.sidebar-footer .user-avatar',
      '.account-avatar-preview',
      '.session-manager-avatar',
    ]) {
      expect(styles).toMatch(new RegExp(`${selector.replace(/[-. ]/g, '\\$&')}\\s*\\{[^}]*border-radius:\\s*50%`, 's'));
    }
  });
});
