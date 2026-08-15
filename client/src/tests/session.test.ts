import { describe, expect, it } from 'vitest';
import { bootNeedsContentHydration, focusedSessionTab, restorePersistedSession } from '../chat/session';
import * as Layout from '../layout/tree';

const noteTab = (id: string, title: string) => ({ id, title, type: 'note' as const, dirty: true });

describe('vault workspace session restore', () => {
  it('adopts the legacy top-level workspace for the active vault', () => {
    const layout = {
      type: 'pane' as const,
      id: 'legacy-pane',
      tabIds: ['note-a'],
      activeTabId: 'note-a',
    };

    const restored = restorePersistedSession({
      activeVaultId: 'vault-a',
      openTabs: [noteTab('note-a', 'Alpha')],
      layout,
      focusedPaneId: 'legacy-pane',
    });

    expect(restored.openTabs).toEqual([{ ...noteTab('note-a', 'Alpha'), dirty: false }]);
    expect(restored.layout).toEqual(layout);
    expect(restored.focusedPaneId).toBe('legacy-pane');
    expect(restored.workspacesByVault['vault-a']).toEqual({
      openTabs: restored.openTabs,
      layout,
      focusedPaneId: 'legacy-pane',
    });
  });

  it('restores only the active vault while retaining every saved workspace', () => {
    const restored = restorePersistedSession({
      activeVaultId: 'vault-b',
      // A stale top-level mirror must not override the per-vault map.
      openTabs: [noteTab('stale', 'Stale')],
      layout: { type: 'pane', id: 'stale-pane', tabIds: ['stale'], activeTabId: 'stale' },
      focusedPaneId: 'stale-pane',
      workspacesByVault: {
        'vault-a': {
          openTabs: [noteTab('note-a', 'Alpha')],
          layout: { type: 'pane', id: 'pane-a', tabIds: ['note-a'], activeTabId: 'note-a' },
          focusedPaneId: 'pane-a',
        },
        'vault-b': {
          openTabs: [noteTab('note-b', 'Beta')],
          layout: { type: 'pane', id: 'pane-b', tabIds: ['note-b'], activeTabId: 'note-b' },
          focusedPaneId: 'pane-b',
        },
      },
    });

    expect(restored.openTabs.map((tab) => tab.id)).toEqual(['note-b']);
    expect(Layout.getActiveTabIds(restored.layout)).toEqual(['note-b']);
    expect(restored.focusedPaneId).toBe('pane-b');
    expect(restored.workspacesByVault['vault-a'].openTabs.map((tab) => tab.id)).toEqual(['note-a']);
    expect(restored.workspacesByVault['vault-b'].openTabs.map((tab) => tab.id)).toEqual(['note-b']);
  });

  it('sanitizes each vault independently and repairs invalid focus', () => {
    const restored = restorePersistedSession({
      activeVaultId: 'vault-a',
      workspacesByVault: {
        'vault-a': {
          openTabs: [noteTab('valid-a', 'Valid A'), { id: 'bad', title: 'Bad', type: 'unknown' }],
          layout: {
            type: 'pane',
            id: 'pane-a',
            tabIds: ['valid-a', 'missing'],
            activeTabId: 'missing',
          },
          focusedPaneId: 'missing-pane',
        },
        'vault-b': {
          openTabs: [noteTab('valid-b', 'Valid B')],
          activeTabId: 'valid-b',
        },
      },
    });

    expect(restored.openTabs.map((tab) => tab.id)).toEqual(['valid-a']);
    expect(Layout.getActiveTabIds(restored.layout)).toEqual(['valid-a']);
    expect(restored.focusedPaneId).toBe('pane-a');
    expect(Layout.getActiveTabIds(restored.workspacesByVault['vault-b'].layout)).toEqual(['valid-b']);
  });

  it('knows which restored tab must hydrate before the workspace paints', () => {
    const withChat = restorePersistedSession({
      activeVaultId: 'vault-a',
      openTabs: [{ id: 'chan', title: 'general', type: 'chat' }],
      layout: { type: 'pane', id: 'pane-a', tabIds: ['chan'], activeTabId: 'chan' },
      focusedPaneId: 'pane-a',
    });
    expect(focusedSessionTab(withChat)?.id).toBe('chan');
    expect(bootNeedsContentHydration(withChat)).toBe(true);

    const empty = restorePersistedSession({ activeVaultId: 'vault-a' });
    expect(focusedSessionTab(empty)).toBeNull();
    expect(bootNeedsContentHydration(empty)).toBe(false);
  });
});
