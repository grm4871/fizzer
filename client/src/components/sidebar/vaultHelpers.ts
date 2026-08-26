import { isSharedVault, type Vault } from '../../api';

/** Switcher label: shared vaults include a member count for quick scanning. */
export function vaultOptionLabel(vault: Vault): string {
  if (!isSharedVault(vault)) return vault.name;
  return `${vault.name} · shared · ${vault.memberCount}`;
}

