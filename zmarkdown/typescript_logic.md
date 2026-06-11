  Logic in TypeScript that could move to SQL

  HIGH IMPACT (repeated patterns / core logic)

  1. Permission checking (data/permissions.ts:68-91)
  _checkPermission resolves whether a user can read/write/comment on a genus. It fetches
  the genus, checks owner bypass, fetches permissions, then calls resolvePermissions(). You
   already have user_has_space_access() in SQL for spaces - there's no equivalent
  user_has_genus_access(genus_id, user_id, perm_type) for genus. This would replace ~25
  lines of TS and is called on nearly every route.

  2. Batch permission filtering (data/permissions.ts:194-221)
  filterReadableNetdocIds does multiple Prisma queries + TS-side filtering to determine
  which genus IDs a viewer can read. Could be a single SQL function
  filter_readable_genus_ids(genus_ids TEXT[], viewer_id UUID) RETURNS TEXT[].

  3. "Add item to space with next order_key" pattern (appears 4 times)
  - netdoc/crud.ts:95-107 (create netdoc → add to space)
  - chat/crud.ts:78-86 (create chat → add to space)
  - subscriptions.ts:52-66 (subscribe → add to saved space)
  - data/subscriptions.ts:35-51 (subscribe to space)

  All do: SELECT MAX(order_key) then INSERT INTO space_items. A SQL function
  add_to_space(space_id, genus_id) RETURNS INT would replace all four.

  4. Version creation on netdoc edit (netdoc/crud.ts:394-407)
  Before updating netdoc content, it saves the old content as a netdoc_version. This is a
  perfect candidate for a BEFORE UPDATE OF content ON netdoc trigger. The trigger would
  create the version row automatically whenever content changes.

  5. Owner-as-member on space create (spaces/crud.ts:166-172)
  After creating a space, TS separately inserts the owner as a space_members row with role
  'owner'. Should be an AFTER INSERT ON spaces trigger (similar to how create_space_jacket
  already works).

  MEDIUM IMPACT (business rules that should be enforced at DB level)

  6. Prevent deletion of profile/collection spaces (spaces/crud.ts:405-407)
  Guard is TS-only. Should be a BEFORE DELETE ON spaces trigger that raises an exception
  for profile/collection spaces.

  7. Jacket genus cleanup on space delete (spaces/crud.ts:410-418)
  After deleting a space, TS separately deletes the jacket genus. The existing
  reparent_genera_on_space_delete trigger runs BEFORE DELETE ON spaces but doesn't clean up
   the jacket. This should be added to that trigger.

  8. Owner-can't-unsubscribe check (data/subscriptions.ts:54-58)
  unsubscribeFromSpace checks if user is owner in TS. Should be a BEFORE DELETE ON
  user_space_subscriptions trigger or a SQL function.

  9. DM canonical ordering (data/dms.ts:76,100)
  TS sorts userId1 < userId2 before every insert/lookup. The CHECK constraint user_id_1 <
  user_id_2 exists but doesn't auto-sort. A SQL function
  get_or_create_dm_conversation(user1, user2) that handles the ordering internally would
  eliminate this.

  10. DM status messages (data/dms.ts:198-231)
  On each message send, TS checks if it's the first message or first reply, then creates
  status messages. Could be an AFTER INSERT ON dm_message trigger that checks existing
  message counts and inserts status rows.

  11. DM conversation filtering (data/dms.ts:255-356)
  getUserDMConversations and getUserDMRequests both fetch all conversations, include all
  messages, then filter in TS. These should be SQL views or functions:
  - get_active_dm_conversations(user_id) - conversations where user has sent messages
  - get_dm_requests(user_id) - conversations where only the other user has sent messages

  12. IP registration rate limit (auth.ts:77-85)
  Counts TOS acceptances per IP in TS. Could be a SQL function
  check_ip_registration_limit(ip TEXT, max INT) RETURNS BOOLEAN or even a constraint.

  LOWER IMPACT (nice-to-have)

  13. Chat creation flow (chat/crud.ts:48-73)
  Creates genus → creates netdoc (trigger creates companion chat) → updates chat to
  standalone → grants permissions. This multi-step dance could be a SQL function
  create_standalone_chat(name, creator_id, space_id) RETURNS TEXT that does it all
  atomically.

  14. Netdoc creation flow (netdoc/crud.ts:58-86)
  Creates genus+netdoc → optionally sets DM perms to whitelist → grants permissions. Could
  be a SQL function create_netdoc(name, creator_id, space_id, is_dm, is_unlisted) RETURNS
  TEXT.

  15. Notification generation (utils/notifications.ts:21-154)
  The "create notification for all subscribed users except author" part could be a SQL
  function generate_notifications(genus_id, event_type, author_id, message, content). The
  socket emission part must stay in TS.

  16. Sidebar reorder (sidebar.ts:67-88)
  Uses a two-pass approach (temp order keys, then real order keys) to avoid unique
  constraint violations. Could be a SQL function reorder_space_items(items JSONB).

  17. Space subscription reorder (data/subscriptions.ts:65-75)
  Loop of individual updates. Could be a SQL function taking a JSON array.

  18. getUserProfileSpaceId / getUserSavedSpaceId (utils/spaces_and_sidebar.ts)
  Simple lookups that could be SQL functions (similar to the existing
  get_profile_jacket_id).

  SHOULD STAY IN TYPESCRIPT

  - JWT/bcrypt auth (needs Node crypto libraries)
  - Socket.io emissions (runtime communication)
  - File upload URL generation (GCS SDK)
  - Recommendation scoring algorithm (complex in-memory math, fine in TS)
  - HTTP error codes/messages (per your instruction)
  - Request validation and response formatting