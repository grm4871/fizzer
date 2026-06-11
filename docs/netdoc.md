# NETDOC Specification v1.1

## Overview

NETDOC is a unified data primitive that replaces separate concepts of posts, documents, channels, and chat messages with a single flexible structure. A NETDOC can function as a document (NOTE), a chat room (CHAT), or any hybrid combination.

---

## Core Data Structure

### Netdoc

```
Netdoc {
  id: Number (guaranteed unique, primary key)
  name: String
  content: String
  creator_id: UUID
  created_at: Timestamp
  updated_at: Timestamp
  permissions: Permission[]
  backlinks: Number[]
  comments: Number[]
  versions: Number[]
  extensions: (extensionId: String, extensionData: Any)[]
}
```

### Permission

```
Permission {
  id: Number
  netdoc_id: Number
  permission_type: String ('read', 'edit', 'comment', or custom)
  user_id: UUID | null | '00000000-0000-0000-0000-000000000002'
  
  Special Values:
    - user_id = null: "nobody" (permission denied)
    - user_id = '00000000-0000-0000-0000-000000000002' (EVERYONE_UUID): "everyone"
}
```

### Field Definitions

- **id**: Unique numeric identifier for the netdoc. Immutable once assigned.
- **name**: Human-readable title/label for the netdoc.
- **content**: The primary text content of the netdoc (markdown/plain text).
- **creator_id**: UUID of the user who created this netdoc. Used for default ownership.
- **created_at**: Timestamp of netdoc creation.
- **updated_at**: Timestamp of last update.
- **permissions**: Extendable array of Permission objects for fine-grained access control.
  - Permission types are extensible: currently `read`, `edit`, `comment`, but can be extended with custom permissions.
  - Each permission type can have multiple entries (e.g., "read" permission for user A, "read" permission for everyone, "edit" permission for user B).
  - Special user_id values:
    - `null`: "nobody" – this permission type is explicitly denied (whitelist mode).
    - `'00000000-0000-0000-0000-000000000002'` (EVERYONE_UUID): "everyone" – this permission type is public/open to all.
- **backlinks**: Array of netdoc IDs that reference this netdoc in some way (comments, content embeds, or versions). The server maintains this automatically based on relationships in other netdocs.
- **comments**: Array of netdoc IDs representing child netdocs that are threaded comments/messages on this netdoc.
- **versions**: Array of netdoc IDs representing historical edits. When a netdoc is edited, the current version ID is pushed to this array.
- **extensions**: Key-value pairs for additional features (e.g., `mp3` player, `image` viewer). Extensions are ignored in the base app implementation but reserved for future use.

---

## UI Behavior

### Routing
- **URL pattern**: `/(netdoc.id)`
- Each netdoc is accessible at its numeric ID.

### Layout

#### Collapsible Content Section (Top Half)
- Displays the netdoc's `content` field.
- Collapsible: user can toggle visibility.
- When **expanded**: shows full content with version history link.
- When **collapsed**: content is hidden; only name/title visible.

#### Backlinks Section
- Displays all related netdocs through the `backlinks[]` array.
- Each backlink ID is fetched and displayed as a clickable link to the related netdoc.
- The client doesn't interpret relationship type—it simply presents them as "Related Content" or similar.
- Users clicking on a backlink will navigate to that netdoc, where they can see the actual relationship in context (e.g., if it's a comment, it will appear in the comment thread; if it's a version, it will appear in the versions section).

#### Comments Section (Bottom Half / Chat Window)
- Displays `comments[]` as a chat interface.
- **When content is collapsed**:
  - Load most recent comments at the bottom.
  - Scrolling **up** loads older comment chunks (infinite scroll upward).
- **When content is expanded**:
  - Start at the beginning of the comment thread.
  - Scrolling **down** loads more recent chunks (infinite scroll downward).
- Comments are themselves netdocs, so they can have nested comments (threads).

#### Versions Section
- Displays historical edits from the `versions[]` array.
- Each version is a full netdoc snapshot.
- The latest version is always the current state of the netdoc.
- UI provides a version browser/diff viewer (optional).

---

## Access Control

### Permission Model

Permissions are stored as an extensible array of `Permission` objects. Each permission has:
- **permission_type**: The type of access (e.g., 'read', 'edit', 'comment', custom)
- **user_id**: The user(s) granted this permission with special values:
  - `null` = "nobody" (permission explicitly denied, whitelist mode)
  - `'00000000-0000-0000-0000-000000000002'` (EVERYONE_UUID) = "everyone" (public/open access)

### Permission Logic

For each permission type, check in order:
1. If an entry with the requesting user's ID exists → grant/deny based on that entry
2. If an entry with EVERYONE_UUID exists → grant permission
3. If an entry with null user_id exists → deny permission (explicit denial)
4. Otherwise → apply default (creator has all permissions, others have none)

### Default Permissions

When a netdoc is created, the creator automatically has all permissions. Explicit permissions can be added via the permission table to override defaults or grant access to others.

### Reading
- Check `read` permission entries:
  - If user has explicit read entry → grant
  - If EVERYONE_UUID read entry exists → grant
  - If null read entry exists → deny
  - Otherwise → only creator can read (default: creator-only)

### Commenting
- Check `comment` permission entries:
  - If user has explicit comment entry → grant
  - If EVERYONE_UUID comment entry exists → grant
  - If null comment entry exists → deny
  - Otherwise → only creator can comment (default: creator-only)

### Editing
- Check `edit` permission entries:
  - If user has explicit edit entry → grant
  - If EVERYONE_UUID edit entry exists → grant
  - If null edit entry exists → deny
  - Otherwise → only creator can edit (default: creator-only)

---

## Client-Server Protocol

### Client as RSS Reader
- The client maintains a local list of "subscribed" or "saved" netdocs.
- On startup or periodic refresh, the client queries the server for updates to its saved netdocs.

### Server Push Notifications
- When a netdoc's `comments` or `versions` array is updated, the server sends a real-time notification (via WebSocket/Socket.IO) to subscribed clients.
- Notification payload includes:
  - `netdocId`: The ID of the updated netdoc.
  - `updateType`: `"comment"` or `"version"`.
  - `timestamp`: When the update occurred.

### Client Load Behavior
- On page load, the client checks with the server for any updates to netdocs in the user's sidebar/saved list.
- The server responds with a list of `netdocId`s that have new `comments` or `versions` since the client's last sync.

### API Endpoints (Proposed)

```
GET /netdoc/:id
  - Fetch a netdoc by ID.
  - Query params: ?includeComments=true&includeVersions=true&includeBacklinks=true
  - Returns: full netdoc object or 403 if access denied.

POST /netdoc/:id/comment
  - Add a comment to a netdoc.
  - Body: { content, name, authorId }
  - Server creates a new netdoc and appends to parent's comments[].

POST /netdoc/:id/edit
  - Edit a netdoc's name or content.
  - Body: { name?, content? }
  - Server pushes current state to versions[], then updates netdoc.

GET /netdoc/:id/versions
  - Fetch all versions of a netdoc.
  - Returns: array of netdoc IDs from versions[].

GET /netdoc/:id/backlinks
  - Fetch all netdoc IDs that backlink to this netdoc.
  - Returns: array of netdoc IDs.

GET /user/:userId/netdocs
  - Fetch all netdocs saved/subscribed by a user.
  - Returns: array of netdoc IDs or summaries.

POST /user/:userId/subscribe
  - Add a netdoc to the user's saved/subscribed list.
  - Body: { netdocId }

WebSocket Events:
  - "netdoc:updated" -> { netdocId, updateType, timestamp }
```

---

## Implementation Notes

### Database Schema (Proposed)

```sql
CREATE TABLE profile (
  id UUID PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password TEXT NOT NULL,
  joined_at TIMESTAMP DEFAULT NOW(),
  color VARCHAR(6)
);

CREATE TABLE netdoc (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  creator_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Extendable permissions system
CREATE TABLE netdoc_permission (
  id BIGSERIAL PRIMARY KEY,
  netdoc_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  permission_type VARCHAR(50) NOT NULL,
  user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE (netdoc_id, permission_type, user_id)
);

CREATE TABLE netdoc_comment (
  parent_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  comment_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, comment_id)
);

CREATE TABLE netdoc_version (
  parent_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  version_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, version_id)
);

CREATE TABLE netdoc_backlinks (
  netdoc_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  backlink_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  PRIMARY KEY (netdoc_id, backlink_id)
);

CREATE TABLE netdoc_extensions (
  netdoc_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  extension_data JSONB,
  PRIMARY KEY (netdoc_id, extension_id)
);

CREATE TABLE user_subscriptions (
  user_id UUID NOT NULL,
  netdoc_id BIGINT NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, netdoc_id)
);
```

### Backlinks Computation
- Backlinks are computed by the server based on references in the database:
  - For `content_embed`: Scan `content` for links matching `/(netdoc.id)`.
  - For `comment`: Query `netdoc_comments` table for all netdocs referencing this one.
  - For `version`: Query `netdoc_versions` table for all netdocs versioning this one.
- All matching netdoc IDs are collected and returned in the `backlinks[]` array.
- The server maintains these automatically; the client simply displays the IDs.

### Versioning Strategy
- When editing, the server:
  1. Creates a new netdoc with the current `name` and `content`.
  2. Adds the new netdoc ID to `netdoc_versions` table.
  3. Adds the old version ID to the parent netdoc's `versions[]` array.
  4. Updates the parent netdoc with new values.
- Versions are immutable snapshots.

### Comment Threading
- Comments are full netdocs, so they can have their own `comments[]` (nested threads).
- When a comment is added:
  1. A new netdoc is created with the comment content.
  2. The new netdoc ID is added to the parent's `comments[]` array.
  3. The comment entry is added to `netdoc_comments` table linking parent and comment.
- The UI should support collapsing/expanding nested comment threads.

### Extensions
- Extensions are stored as key-value pairs in `netdoc_extensions`.
- The base app ignores extensions but reserves the field for plugins (e.g., audio player, image viewer, custom widgets).

---

## Migration from Current App

### Mapping Old Models to NETDOC

| Old Model       | NETDOC Equivalent                                      |
|-----------------|--------------------------------------------------------|
| `Post` (message)| NETDOC with `content` and no `comments`               |
| `Post` (document)| NOTE (NETDOC with `content` and optional `versions`) |
| `Channel`       | CHAT (NETDOC with `name`, null content, `comments[]`) |
| `participants`  | Replaced by `allowed_readers`, `allowed_commenters`   |
| `sidebar_items` | User subscriptions to netdocs                         |

### Migration Steps
1. Convert each `channel` to a CHAT netdoc.
2. Convert each `document` post to a NOTE netdoc with `versions`.
3. Convert each `message` post to a comment netdoc under its parent channel/netdoc.
4. Map `participants` to `allowed_commenters` on CHAT netdocs.
5. Map `sidebar_items` to `user_subscriptions`.

---

## Open Questions / Future Considerations

1. **Permissions inheritance**: Should child netdocs (comments) inherit parent permissions, or have independent ACLs?
2. **Backlinks performance**: Should backlinks be computed on-demand or materialized?
3. **Extensions API**: Define a formal plugin/extension interface for future use.
4. **Version diffs**: Should the server compute and store diffs between versions, or reconstruct them on demand?
5. **Search**: How to index and search across netdocs (full-text search on `name` and `content`)?
6. **Backlink UI organization**: Should backlinks be grouped by direction (incoming vs outgoing) or by type (comment vs embed vs version)?

---

## Summary

NETDOC unifies documents, chat rooms, and threaded discussions into a single flexible primitive with simple arrays for all relationships. By treating everything as a netdoc and using simple ID arrays for `backlinks`, `comments`, and `versions`, the app simplifies both the data model and client logic. The server handles all relationship metadata; the client simply fetches related netdocs by ID to see how they're related in context. This clean separation of concerns makes the client leaner and the server more flexible for future enhancements.
