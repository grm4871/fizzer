# Plan: Abstract History Stack Logic for Tab-less Navigation

## Problem
The history stack logic is currently embedded in tab-specific code. When `showTabs` is false, users still need back/forward navigation, but the current implementation:
1. Ties history to `Tab` objects
2. Duplicates history logic across `navigateToNetdocInTab`, `navigateToProfileInTab`, etc.
3. Doesn't work when navigating via direct `navigate()` calls

## Solution: Abstract History Stack Manager

Create a reusable history stack that can be used:
1. **Per-tab** (existing behavior when `showTabs` is true)
2. **Standalone** (when `showTabs` is false - single window mode)

### History Stack Interface

```ts
interface HistoryStack<T> {
  entries: T[];
  index: number;
}

// Core operations (pure functions)
function pushToHistory<T>(stack: HistoryStack<T>, entry: T): HistoryStack<T> {
  // Truncate forward history, push new entry
  const newEntries = stack.entries.slice(0, stack.index + 1);
  newEntries.push(entry);
  return { entries: newEntries, index: newEntries.length - 1 };
}

function navigateHistory<T>(stack: HistoryStack<T>, direction: -1 | 1): HistoryStack<T> | null {
  const newIndex = stack.index + direction;
  if (newIndex < 0 || newIndex >= stack.entries.length) return null;
  return { ...stack, index: newIndex };
}

function canGoBack(stack: HistoryStack<any>): boolean {
  return stack.index > 0;
}

function canGoForward(stack: HistoryStack<any>): boolean {
  return stack.index < stack.entries.length - 1;
}

function getCurrentEntry<T>(stack: HistoryStack<T>): T | null {
  return stack.entries[stack.index] ?? null;
}
```

## Key Files to Modify

### 1. `/Users/diego/mystuff/Coding/netaris/client/src/top/historyStack.ts` (NEW)
- Create the abstract history stack utilities

### 2. `/Users/diego/mystuff/Coding/netaris/client/src/top/useTabs.ts`
- Import and use history stack utilities
- Refactor `navigateToNetdocInTab`, etc. to use shared functions
- Add URL sync effect that uses the same push logic
- When `showTabs` is false, use a standalone history stack (not tied to tabs)

## Implementation Steps

1. **Create historyStack.ts** with pure functions for history management

2. **Refactor useTabs.ts**:
   - Use `pushToHistory` in all navigate functions
   - Use `navigateHistory` in `handleTabBack`/`handleTabForward`
   - Add `isInternalNavRef` to track back/forward navigation
   - Add URL sync effect that calls `pushToHistory` for direct `navigate()` calls

3. **Handle showTabs=false case**:
   - When no tabs visible, still maintain history stack on the single active tab
   - The URL sync effect ensures history is tracked regardless of how navigation happens

## Verification
1. Set `showTabs` to false
2. Navigate to netdoc A → profile B → netdoc C
3. Click back → should go to profile B
4. Click back → should go to netdoc A
5. Click forward → should go to profile B
6. Navigate to netdoc D → forward history should be cleared
7. Click back → should go to profile B (not netdoc C)
