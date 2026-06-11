# State Location Refactoring

States that need to be moved from their current location to their ideal location.

| State | Header | Sidebar | Middle | Footer | Current location | Ideal location |
|-------|--------|---------|--------|--------|------------------|----------------|
| `isCreatingNewNetdoc/Chat` | ✓ | | ✓ | | `MainLayout.tsx` | derive from route |
| `isMuted/isDeafened/isInVoiceCall` | | ✓ | | | `states.tsx` | voice hook or sidebar |
| `sidebar collapsed states` | | ✓ | | | `states.tsx` | each sidebar |
| `headerHeight/footerHeight` | | ✓ | | | `MainLayout.tsx` | sidebars self-measure |
| `newNetdocTitle/newChatTitle` | | | ✓ | | `MainLayout.tsx` | `NewNetdoc.tsx` |
| `pseudoWindowReturnPath` | | | ✓ | | `MainLayout.tsx` | URL param or Settings |
