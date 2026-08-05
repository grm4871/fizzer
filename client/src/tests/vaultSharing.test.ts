import { describe, expect, it } from 'vitest';
import { isSharedVault, type Vault } from '../api';
import { vaultOptionLabel } from '../components/Sidebar';

const vault = (overrides: Partial<Vault> = {}): Vault => ({
  id: 'v1',
  name: 'Team notes',
  root_path: '/tmp/v1',
  created_at: '2026-01-01 00:00:00',
  ...overrides,
});

describe('shared vault indicators', () => {
  it('treats a vault with more than one member as shared', () => {
    expect(isSharedVault(vault({ memberCount: 3 }))).toBe(true);
    expect(isSharedVault(vault({ memberCount: 1 }))).toBe(false);
  });

  it('assumes private when the server did not send a member count', () => {
    // A freshly created vault comes back from POST /api/vaults without membership fields.
    expect(isSharedVault(vault())).toBe(false);
    expect(vaultOptionLabel(vault())).toBe('Team notes');
  });

  it('labels shared vaults in the switcher with their member count', () => {
    expect(vaultOptionLabel(vault({ memberCount: 3, role: 'editor' }))).toBe('Team notes · shared · 3');
    expect(vaultOptionLabel(vault({ memberCount: 1, role: 'owner' }))).toBe('Team notes');
  });
});
