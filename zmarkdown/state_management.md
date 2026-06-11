# State Management Options

## Current Pattern for `newNetdocTitle`

```
MainLayout (owns newNetdocTitle)
    │
    ├─── DOWN: menuTitle to Header (display)
    │
    └─── DOWN: newNetdocTitle → MainLayoutMiddle → NetdocEditor → EditorTemplate
                                                                      │
                                                                      ▼
                                                            editTitle (local state)
                                                            initialized from initialTitle
                                                                      │
                                                                      ▼
                                                            user types, editTitle changes
                                                                      │
                                                         UP: onTitleChange(editTitle)
                                                                      │
                                                         ◄────────────┘
                                                                      │
                                                            setNewNetdocTitle()
                                                                      │
                                                            MainLayout updates
```

## Options

### 1. Keep as-is
Standard React pattern: parent owns state, child gets initial + callback, child has local state and syncs back. Normal.

### 2. Context
Put `newNetdocTitle` in context so Header/Middle grab it directly instead of prop drilling. Reduces drilling but adds context overhead for one piece of state.

### 3. Fully controlled
Remove local `editTitle` in EditorTemplate, use prop directly. **Bad idea** - every keystroke re-renders MainLayout.

### 4. Don't sync back
EditorTemplate keeps local state, only syncs on save. But then header won't show title in real-time.

### 5. URL-based
`/netdoc/new?title=Foo`. Components read from URL. Weird UX though.

## Conclusion

The "fucky" feeling is mostly the 4-level prop drilling (MainLayout → MainLayoutMiddle → NetdocEditor → EditorTemplate). Context would fix that, but might be overkill for one state variable.
