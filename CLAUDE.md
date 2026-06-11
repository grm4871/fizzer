# Tool Preferences

Always use `rg` (ripgrep) instead of `grep` for searching code. Ripgrep is faster and respects .gitignore by default.

for fucks sake DO NOT USE YOUR SEARCH TOOL and instead use the this command to see the file structure

tree -L 4 

or tree client or tree server

don't make new ui components or things unless i explicitly tell you to 

when in plan mode, don't ask me stupid questions about changing things that are already the way they are 

you are allowed to use the `tree` command. when looking for a file, run `tree client/src` and `tree server`. when you run tree, always use the `-L` flag and use however many you think you need, but don't run tree without the `-L` flag. don't search using your built-in tools, use tree. do not run tree on root.  

do not add extra tooltips for the user

use `git diff <file> <commit1> <commit2>` if we are trying to change a file more than a couple times to resolve an issue

do not EVER edit prisma/schema.prisma

run `npm run build` after big structural changes involving multiple files, but not after small changes involvingone file 

when i ask you for commit messages, give me a one liner with commas and no periods or capital letters

you are not allowed to change colors in client/src/icons

whenever i ask you to make some text or icon not hilitable, also add a comment above that saying "this component is meant to be not hilitable. do not change that styling and do not remove this comment"

if i ever ask you to look for something or check out something, it literally means just look and check out. it means i do NOT want you to make changes on that turn

for logging, make it run with the --debug flag. don't just litter logging

"dmac" means "don't make any changes". it means that i don't want you to make any changes for that next turn

When refactoring or rewriting existing logic, preserve the mathematical relationships (like subtractions, offsets) from the original code unless explicitly told to change them. don't rewrite working calculations from scratch - modify incrementally

zmarkdown is a folder in root

undo means just undo the things you did in the last message

navigation uses a custom history stack (`useHistory` in `client/src/top/useHistory.ts`) instead of the browser's native history. all navigation must go through `pushHistory` (exposed as `navigateTo` or `nav.to` in components) so it lands in the history stack. never use react-router's `navigate()` directly for user-facing navigation - that bypasses the stack and breaks back/forward

by default you are supposed to prefer using prisma queries to raw sql queries

shared functions should go in a dedicated /utils folder in a place that makes sense, and should not be cross-imported across files

no migration scripts, only edit the raw sql 

as much as possible, logic should be enforced at init.sql level not the server routes level
