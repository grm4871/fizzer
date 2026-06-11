# WYSIWYG Markdown Hotkeys

## Architecture

```
Keypress
│
├── Shift+* ─┐
├── Shift+~ ─┼──→ applySelectionTransform(transformFn)
├── Ctrl+I ──┤         │
└── Ctrl+B ──┘         ▼
                 ┌─────────────────────────────┐
                 │ 1. Check selection exists   │
                 │ 2. Get cursor position      │
                 │ 3. Find selection bounds    │
                 │ 4. Call transformFn() ──────┼──→ cycleAsterisk
                 │ 5. setEditContent()         │    toggleItalic
                 │ 6. Update innerHTML         │    toggleBold
                 │ 7. Restore selection        │    toggleStrikethrough
                 └─────────────────────────────┘
                              │
                              ▼
                 ┌─────────────────────────────┐
                 │ Transform functions:        │
                 │                             │
                 │ cycleAsterisk:  (n+1) % 4   │
                 │ toggleItalic:   ±1 asterisk │
                 │ toggleBold:     ±2 asterisk │
                 │ toggleStrike:   0↔2 tildes  │
                 └─────────────────────────────┘
```

## Step 4: Transform Functions

### `cycleAsterisk` (Shift+8)
Adds one asterisk at a time, cycling back to zero after three.
- 0 asterisks → 1 (plain → *italic*)
- 1 asterisk → 2 (*italic* → **bold**)
- 2 asterisks → 3 (**bold** → ***bold+italic***)
- 3 asterisks → 0 (***bold+italic*** → plain)

### `toggleItalic` (Ctrl+I)
Toggles the italic layer (±1 asterisk), preserving bold if present.
- 0 asterisks → 1 (plain → *italic*)
- 1 asterisk → 0 (*italic* → plain)
- 2 asterisks → 3 (**bold** → ***bold+italic***)
- 3 asterisks → 2 (***bold+italic*** → **bold**)

### `toggleBold` (Ctrl+B)
Toggles the bold layer (±2 asterisks), preserving italic if present.
- 0 asterisks → 2 (plain → **bold**)
- 1 asterisk → 3 (*italic* → ***bold+italic***)
- 2 asterisks → 0 (**bold** → plain)
- 3 asterisks → 1 (***bold+italic*** → *italic*)

### `toggleStrikethrough` (Shift+~)
Toggles strikethrough (0↔2 tildes). Fixes malformed single tilde.
- 0 tildes → 2 (plain → ~~strikethrough~~)
- 1 tilde → 2 (malformed → ~~strikethrough~~)
- 2 tildes → 0 (~~strikethrough~~ → plain)

## Whitespace Handling
All transforms preserve leading/trailing whitespace outside markers:
```
"  hello  " → "  *hello*  "  (not "*  hello  *")
```

## hotkeys.tsx Structure

```
hotkeys.tsx
│
├── transformAsteriskMarkers(text, start, end, countFn)
│   │  ↳ handles *, _ markers (interchangeable)
│   │
│   ├── toggleItalic    → countFn: n => [1,0,3,2][n]
│   ├── toggleBold      → countFn: n => [2,3,0,1][n]
│   └── cycleAsterisk   → countFn: n => (n+1) % 4
│
├── transformSingleCharMarkers(text, start, end, char, countFn)
│   │  ↳ handles any single char marker
│   │
│   └── toggleStrikethrough → char: '~', countFn: n => n===2 ? 0 : 2
│
└── useEditorHotkeys()
    │
    └── applySelectionTransform(transformFn)
        │  ↳ shared: selection → transform → update → restore
        │
        ├── Shift+*  → cycleAsterisk
        ├── Shift+~  → toggleStrikethrough
        ├── Ctrl+I   → toggleItalic
        └── Ctrl+B   → toggleBold
```
