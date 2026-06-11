# Split Editor Components

Split NetdocEditor into three focused components:
1. **NetdocEditor** - editing existing netdocs only
2. **NewNetdoc** - creating new netdocs (title + body + permissions)
3. **NewChat** - creating new chats (title only)

## Files to Create

### 1. `client/src/pages/NewNetdoc.tsx` (~200 lines)
Extract new netdoc creation from NetdocEditor:
- Title input + content textarea
- DocumentButtons with `isNewMode={true}` (hides versions, share; shows perms, upload/download based on content)
- Pending permissions support
- Save creates netdoc then applies permissions
- Props: `profileId`, `onCreated`, `onCancel`, `onTitleChange`, `onPermissions`, `pendingPermissions`, `isElectron`

### 2. `client/src/reusable/CommentPermsInput.tsx` (~150 lines)
Extract comment permissions section from PermissionsMenu:
- Username input with tag display
- Everyone toggle
- Blacklist section (when Everyone is selected)
- Props: `commentUsers`, `commentBlacklist`, `onCommentUsersChange`, `onCommentBlacklistChange`, `currentUserId`

### 3. `client/src/pages/NewChat.tsx` (~120 lines)
Title-only netdoc creation for chats:
- Title input only (no content textarea)
- Save/Cancel buttons (minimal toolbar)
- CommentPermsInput embedded below title
- Save hits `/api/netdoc` endpoint with empty content, applies comment permissions
- Props: `profileId`, `onCreated`, `onCancel`, `onTitleChange`

## Files to Modify

### 4. `client/src/pages/NetdocEditor.tsx`
Restore to clean state from commit `9979e809d05b6fed28417be97d6d941e13d9b4c1`:
- Remove props: `isNewMode`, `onNetdocCreated`, `pendingPermissions`
- Remove all new mode conditionals and permissions application code
- Clean ~280 lines, just for editing existing netdocs
- Props: `netdoc`, `netdocId`, `profileId`, `onNetdocUpdate`, `onNetdocLoad`, `onCancel`, `onSaveComplete`, `onUpload`, `onDownload`, `onVersions`, `onPermissions`, `onBookmarkChange`, `onContentChange`, `onTitleChange`, `isBookmarked`, `isOwner`, `isRemote`, `isElectron`

### 5. `client/src/pages/PermissionsMenu.tsx`
Refactor to use CommentPermsInput:
- Extract `renderPermissionSection` logic for comment into CommentPermsInput
- Import and use CommentPermsInput for the comment section
- Keep read/edit sections as-is

### 6. `client/src/layouts/components/MainLayoutContent.tsx`
Update to use new components:
- Import `NewNetdoc` instead of using `NetdocEditor` with `isNewMode`
- Change `isCreatingNewNetdoc` block to render `<NewNetdoc ... />`
- Add state/rendering for NewChat when that feature is ready

### 7. `client/src/reusable/DocumentButtons.tsx`
- Keep `isNewMode` prop (NewNetdoc will pass it)
- NewChat won't use DocumentButtons (just simple save/cancel)

## Implementation Order
1. Create NewNetdoc.tsx (extract from NetdocEditor)
2. Update MainLayoutContent to use NewNetdoc
3. Clean up NetdocEditor (remove new mode code)
4. Create CommentPermsInput.tsx (extract from PermissionsMenu)
5. Update PermissionsMenu to use CommentPermsInput
6. Create NewChat.tsx using CommentPermsInput
7. Wire up NewChat in MainLayoutContent

## Verification
- Create new netdoc: same behavior as before (title + body + perms)
- Edit existing netdoc: same behavior as before
- Permissions work in new netdoc mode
- PermissionsMenu still works (now uses extracted component)
- NewChat shows title + comment perms inline, creates netdoc with empty content
