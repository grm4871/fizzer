# Vi Mode Commands

Vi mode is enabled when "Hacker" is selected in Settings > Preferences > Editor Mode.

## Modes

- Normal: navigation and commands (-- NORMAL --)
- Insert: text input (-- INSERT --)
- Replace: overwrite text (-- REPLACE --)
- Visual: selection (-- VISUAL --)
- Visual Block: rectangular selection (-- VISUAL BLOCK --)
- Search: find text (/query or ?query)
- Command: ex commands (:command)

## Mode Switching

- Escape: return to Normal mode
- i: insert at cursor
- a: insert after cursor
- I: insert at first non-whitespace
- A: insert at end of line
- o: open line below
- O: open line above
- v: enter Visual mode
- V: enter Visual line mode (select entire line)
- R: enter Replace mode (overwrite)
- /: search forward
- ?: search backward
- :: enter Command mode
- Mouse selection: enters Visual mode automatically

## Numeric Counts

Most commands accept a numeric prefix:
- 3w: move 3 words forward
- 5dd: delete 5 lines
- 2x: delete 2 characters
- 10G: go to line 10 (not implemented yet)
- 4j: move down 4 lines

## Movement

- h/l or Arrow keys: left/right character
- j/k or Arrow keys: down/up line
- w/b: next/previous word
- W/B: next/previous WORD (whitespace-delimited)
- e/E: end of word/WORD
- 0: start of line
- $: end of line
- ^: first non-whitespace
- {/}: previous/next paragraph
- (/): previous/next sentence
- gg: start of document
- G: end of document
- g0/g$/g^: display line variants
- gj/gk: display line up/down
- Backspace: move left (normal mode)
- %: jump to matching bracket

## Find on Line

- f{char}: find char forward on line
- F{char}: find char backward on line
- t{char}: to char forward (stop before)
- T{char}: to char backward (stop after)
- ;: repeat last f/F/t/T
- ,: repeat last f/F/t/T in opposite direction

## Marks

- m{a-z}: set mark at current position
- '{a-z}: jump to line of mark
- `{a-z}: jump to exact position of mark
- '' or ``: jump back to previous position

## Editing

- x: cut character under cursor (or selection)
- X: cut character before cursor
- Delete: delete character under cursor
- s: substitute character (delete + insert)
- S: substitute line (like cc)
- J: join current line with next line
- p: paste after cursor
- P: paste before cursor
- ~: toggle case
- r{char}: replace single character under cursor
- u: undo
- Ctrl+Z: undo (all modes)
- Ctrl+Y / Ctrl+Shift+Z: redo (all modes)
- Ctrl+S: save (all modes)

## Delete with motion (d)

- dd: delete line
- dw: delete word
- de: delete to end of word
- db: delete to start of word
- d$: delete to end of line
- D: delete to end of line (shortcut for d$)
- d0: delete to start of line
- dh/dj/dk/dl: delete with h/j/k/l motion
- dG: delete to end of document
- dgg: delete to start of document

## Change with motion (c)

- cc: change line (preserves indent)
- cw: change word
- ce: change to end of word
- cb: change to start of word
- c$: change to end of line
- C: change to end of line (shortcut for c$)
- ch/cj/ck/cl: change with h/j/k/l motion
- cG: change to end of document
- cgg: change to start of document

## Yank (copy)

- yy: yank line
- yw: yank word
- ye: yank to end of word
- yb: yank to start of word
- y$: yank to end of line
- y0/y^: yank to start of line
- yG: yank to end of document
- ygg: yank to start of document

## Repeat

- .: repeat last delete, change, or insert action

## Visual Mode

Movement keys extend selection. Then:

- y: yank selection
- d/x: delete selection
- c: change selection (delete + insert mode)
- ~: toggle case of selection
- /?: search (extends selection)
- n/N: repeat search (extends selection)
- Alt+Up/Down: switch to Visual Block mode

## Visual Block Mode

Rectangular/column selection mode. Enter with:
- Alt+click: start visual block at cursor
- Alt+Up/Down from Visual mode: switch to block mode

Movement (h/j/k/l or arrows) moves the block corner. Then:
- y: yank block
- d/x: delete block (from each line)
- c: change block (delete + insert mode)

## Search

- /query + Enter: search forward
- ?query + Enter: search backward
- n: repeat search same direction
- N: repeat search opposite direction

## Command Mode

- :w or :write: save
- :q: quit
- :q!: force quit (discard changes)
- :wq or :x: save and quit
- :{number}: go to line number (e.g., :10)
- :d {number}: delete line number (e.g., :d 5)
- ZZ: save and quit (normal mode shortcut)
- ZQ: quit without saving (normal mode shortcut)
