-- ============================================================================
-- MIGRATION: Master (netdoc-centric) → Genus-based schema
--
-- Starting state: master branch with netdoc-centric model.
--   - sidebar_folders, sidebar_items (not yet renamed)
--   - netdoc has: name, creator_id, is_unlisted, is_chat, topic, etc.
--   - netdoc_permission with EVERYONE_UUID pattern
--   - netdoc_notifications with FK to sidebar_items
--   - dm_message with message_netdoc_id FK to netdoc
--   - No spaces, no perms_mode, no jackets, no genus
--
-- Target: genus as base entity, spaces with perms_mode, single permission
-- table, chat table, frozen permissions, space_permission.
--
-- Run perms.sql BEFORE this migration (for perms_mode type + functions).
-- Run init.sql, jacket.sql, create.sql, perms_triggers.sql, etc. AFTER.
-- ============================================================================

BEGIN;

-- ============================================================================
-- PHASE 0: Drop old triggers that will conflict
-- ============================================================================

DROP TRIGGER IF EXISTS trigger_auto_generate_netdoc_id ON netdoc;
DROP TRIGGER IF EXISTS trigger_create_user_homepage ON profile;

-- ============================================================================
-- PHASE 1: Create sequences and ID functions
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS genus_id_seq START WITH 2;
CREATE SEQUENCE IF NOT EXISTS space_id_seq START WITH 1;

CREATE OR REPLACE FUNCTION find_earliest_space_id() RETURNS TEXT AS $$
DECLARE
    candidate BIGINT := 1;
    max_check BIGINT := 10000;
BEGIN
    WHILE candidate < max_check LOOP
        IF NOT EXISTS (SELECT 1 FROM spaces WHERE id = int_to_base32(candidate)) THEN
            RETURN int_to_base32(candidate);
        END IF;
        candidate := candidate + 1;
    END LOOP;
    RETURN int_to_base32(nextval('space_id_seq'));
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_earliest_genus_id() RETURNS TEXT AS $$
DECLARE
    candidate BIGINT := 1;
    max_check BIGINT := 10000;
BEGIN
    WHILE candidate < max_check LOOP
        IF NOT EXISTS (SELECT 1 FROM genus WHERE id = int_to_base32(candidate)) THEN
            RETURN int_to_base32(candidate);
        END IF;
        candidate := candidate + 1;
    END LOOP;
    RETURN int_to_base32(nextval('genus_id_seq'));
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PHASE 2: Create new tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS spaces (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    monarch_id UUID REFERENCES profile(id) ON DELETE SET NULL,
    is_profile BOOLEAN NOT NULL DEFAULT FALSE,
    is_collection BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_creator BOOLEAN NOT NULL DEFAULT FALSE,
    jacket TEXT UNIQUE,
    avatar_url TEXT,
    perms_mode_read perms_mode NOT NULL DEFAULT 'blacklist',
    perms_mode_write perms_mode NOT NULL DEFAULT 'whitelist',
    perms_mode_comment perms_mode NOT NULL DEFAULT 'blacklist',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS space_members (
    id BIGSERIAL PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (space_id, user_id)
);

CREATE TABLE IF NOT EXISTS space_permission (
    id BIGSERIAL PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    permission_type VARCHAR(50) NOT NULL,
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    is_blacklist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (space_id, permission_type, user_id, is_blacklist)
);

CREATE TABLE IF NOT EXISTS user_space_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    order_key INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, space_id)
);

CREATE TABLE IF NOT EXISTS genus (
    id TEXT COLLATE case_insensitive PRIMARY KEY CHECK ((id COLLATE "C") ~ '^[a-zA-Z0-9]+$'),
    name VARCHAR(500) NOT NULL,
    creator_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
    perms_mode_read perms_mode NOT NULL DEFAULT 'blacklist',
    perms_mode_write perms_mode NOT NULL DEFAULT 'whitelist',
    perms_mode_comment perms_mode NOT NULL DEFAULT 'blacklist',
    is_unlisted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS genus_permission (
    id BIGSERIAL PRIMARY KEY,
    genus_id TEXT COLLATE case_insensitive NOT NULL REFERENCES genus(id) ON DELETE CASCADE,
    permission_type VARCHAR(50) NOT NULL,
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    is_blacklist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (genus_id, permission_type, user_id, is_blacklist)
);

CREATE TABLE IF NOT EXISTS genus_permission_frozen (
    id BIGSERIAL PRIMARY KEY,
    genus_id TEXT COLLATE case_insensitive NOT NULL REFERENCES genus(id) ON DELETE CASCADE,
    permission_type VARCHAR(50) NOT NULL,
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    is_blacklist BOOLEAN NOT NULL DEFAULT FALSE,
    frozen_by_space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (genus_id, permission_type, user_id, is_blacklist, frozen_by_space_id)
);

CREATE TABLE IF NOT EXISTS chat (
    id TEXT COLLATE case_insensitive PRIMARY KEY REFERENCES genus(id) ON DELETE CASCADE,
    is_standalone BOOLEAN NOT NULL DEFAULT FALSE,
    topic VARCHAR(390) DEFAULT NULL,
    users_can_change_topic BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_message (
    id BIGSERIAL PRIMARY KEY,
    chat_id TEXT COLLATE case_insensitive NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    sender_id UUID REFERENCES profile(id) ON DELETE SET NULL,
    reply_to BIGINT REFERENCES chat_message(id) ON DELETE SET NULL,
    status_message BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS genus_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    genus_id TEXT COLLATE case_insensitive NOT NULL REFERENCES genus(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, genus_id)
);

-- ============================================================================
-- PHASE 3: Add missing columns to existing tables
-- ============================================================================

ALTER TABLE profile ADD COLUMN IF NOT EXISTS folder_dialogue INTEGER NOT NULL DEFAULT 0;
ALTER TABLE netdoc ADD COLUMN IF NOT EXISTS is_jacket BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE netdoc ADD COLUMN IF NOT EXISTS yjs_state BYTEA;
ALTER TABLE netdoc ADD COLUMN IF NOT EXISTS hide_history_from_non_editors BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================================
-- PHASE 4: Create spaces for all real users
-- ============================================================================

DO $$
DECLARE
    u RECORD;
    profile_space_id TEXT;
    saved_space_id TEXT;
BEGIN
    FOR u IN
        SELECT id, display_name FROM profile
        WHERE id NOT IN (
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000001'::uuid,
            '00000000-0000-0000-0000-000000000002'::uuid,
            '99999999-9999-9999-9999-999999999999'::uuid
        )
    LOOP
        profile_space_id := find_earliest_space_id();
        INSERT INTO spaces (id, monarch_id, name, description, is_profile,
                           perms_mode_read, perms_mode_comment, perms_mode_write)
        VALUES (profile_space_id, u.id, u.display_name || '''s Profile', '', TRUE,
                'blacklist', 'blacklist', 'whitelist');

        saved_space_id := find_earliest_space_id();
        INSERT INTO spaces (id, monarch_id, name, description, is_collection,
                           perms_mode_read, perms_mode_comment, perms_mode_write)
        VALUES (saved_space_id, u.id, u.display_name || '''s Saved', '', TRUE,
                'whitelist', 'whitelist', 'whitelist');

        INSERT INTO space_members (space_id, user_id, role)
        VALUES (profile_space_id, u.id, 'monarch'), (saved_space_id, u.id, 'monarch');
    END LOOP;
END $$;

-- ============================================================================
-- PHASE 5: Identify comment netdocs (recursive walk to find root parent)
-- ============================================================================

CREATE TEMP TABLE comment_roots AS
WITH RECURSIVE walk AS (
    SELECT
        nc.comment_netdoc_id,
        nc.parent_netdoc_id,
        nc.parent_netdoc_id AS root_netdoc_id
    FROM netdoc_comment nc
    WHERE nc.parent_netdoc_id NOT IN (
        SELECT comment_netdoc_id FROM netdoc_comment
    )
    UNION ALL
    SELECT
        nc.comment_netdoc_id,
        nc.parent_netdoc_id,
        w.root_netdoc_id
    FROM netdoc_comment nc
    JOIN walk w ON nc.parent_netdoc_id = w.comment_netdoc_id
)
SELECT DISTINCT comment_netdoc_id, root_netdoc_id FROM walk;

CREATE TEMP TABLE comment_ids AS
SELECT DISTINCT comment_netdoc_id AS id FROM netdoc_comment;

CREATE TEMP TABLE dm_netdoc_ids AS
SELECT DISTINCT message_netdoc_id AS id FROM dm_message;

-- ============================================================================
-- PHASE 6: Create genus rows for all non-comment, non-DM netdocs
-- Parent to creator's profile space.
-- ============================================================================

INSERT INTO genus (id, name, creator_id, space_id, is_unlisted, created_at, updated_at)
SELECT
    n.id,
    n.name,
    n.creator_id,
    (SELECT s.id FROM spaces s WHERE s.monarch_id = n.creator_id AND s.is_profile = TRUE LIMIT 1),
    n.is_unlisted,
    n.created_at,
    n.updated_at
FROM netdoc n
WHERE n.id NOT IN (SELECT id FROM comment_ids)
  AND n.id NOT IN (SELECT id FROM dm_netdoc_ids);

-- ============================================================================
-- PHASE 7: Convert EVERYONE_UUID permissions → perms_mode
-- Old schema: EVERYONE_UUID ('0000...0002') row = public access
-- New schema: perms_mode blacklist = public, whitelist = private
-- ============================================================================

-- No EVERYONE read → private (whitelist)
UPDATE genus g
SET perms_mode_read = 'whitelist'
WHERE NOT EXISTS (
    SELECT 1 FROM netdoc_permission np
    WHERE np.netdoc_id = g.id
      AND np.permission_type = 'read'
      AND np.user_id = '00000000-0000-0000-0000-000000000002'
      AND np.is_blacklist = FALSE
);

-- EVERYONE write/edit → public write (blacklist)
UPDATE genus g
SET perms_mode_write = 'blacklist'
WHERE EXISTS (
    SELECT 1 FROM netdoc_permission np
    WHERE np.netdoc_id = g.id
      AND np.permission_type IN ('write', 'edit')
      AND np.user_id = '00000000-0000-0000-0000-000000000002'
      AND np.is_blacklist = FALSE
);

-- ============================================================================
-- PHASE 8: Migrate permissions → genus_permission
-- Skip EVERYONE_UUID rows (converted to perms_mode above), map edit → write
-- ============================================================================

INSERT INTO genus_permission (genus_id, permission_type, user_id, is_blacklist, created_at)
SELECT
    np.netdoc_id,
    CASE np.permission_type WHEN 'edit' THEN 'write' ELSE np.permission_type END,
    np.user_id,
    np.is_blacklist,
    np.created_at
FROM netdoc_permission np
WHERE np.user_id != '00000000-0000-0000-0000-000000000002'
  AND np.user_id IS NOT NULL
  AND np.netdoc_id NOT IN (SELECT id FROM comment_ids)
  AND np.netdoc_id NOT IN (SELECT id FROM dm_netdoc_ids)
  AND np.permission_type IN ('read', 'write', 'edit', 'comment')
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PHASE 9: Create chat rows for all genera
-- Old is_chat = TRUE → is_standalone chat with topic
-- Everything else → companion chat (is_standalone = FALSE)
-- ============================================================================

INSERT INTO chat (id, is_standalone, topic, users_can_change_topic, updated_at)
SELECT n.id, TRUE, n.topic, n.users_can_change_topic, n.updated_at
FROM netdoc n JOIN genus g ON g.id = n.id
WHERE n.is_chat = TRUE;

INSERT INTO chat (id, is_standalone, updated_at)
SELECT n.id, FALSE, n.updated_at
FROM netdoc n JOIN genus g ON g.id = n.id
WHERE n.is_chat = FALSE
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- PHASE 10: Migrate comments → chat_messages
-- Uses recursive root resolution from Phase 5.
-- ============================================================================

INSERT INTO chat_message (chat_id, content, sender_id, status_message, created_at)
SELECT cr.root_netdoc_id, n.content, n.creator_id, FALSE, n.created_at
FROM comment_roots cr
JOIN netdoc n ON n.id = cr.comment_netdoc_id
WHERE cr.root_netdoc_id IN (SELECT id FROM chat)
ORDER BY n.created_at;

-- ============================================================================
-- PHASE 11: Delete comment netdocs (now migrated to chat_messages)
-- ============================================================================

DELETE FROM netdoc WHERE id IN (SELECT id FROM comment_ids);

-- ============================================================================
-- PHASE 12: Migrate DMs — extract content, drop netdoc dependency
-- ============================================================================

ALTER TABLE dm_message ADD COLUMN IF NOT EXISTS content TEXT NOT NULL DEFAULT '';

UPDATE dm_message dm
SET content = n.content
FROM netdoc n
WHERE n.id = dm.message_netdoc_id;

ALTER TABLE dm_message DROP CONSTRAINT IF EXISTS dm_message_conversation_id_message_netdoc_id_key;
ALTER TABLE dm_message DROP COLUMN IF EXISTS message_netdoc_id;

DELETE FROM netdoc WHERE id IN (SELECT id FROM dm_netdoc_ids);

-- ============================================================================
-- PHASE 13: Rename sidebar tables, migrate saved items
-- ============================================================================

-- Track which users had folders (for folder_dialogue flag)
UPDATE profile SET folder_dialogue = 1
WHERE id IN (SELECT DISTINCT user_id FROM sidebar_folders);

-- Drop FK from netdoc_notifications → sidebar_items BEFORE rename
ALTER TABLE netdoc_notifications
    DROP CONSTRAINT IF EXISTS netdoc_notifications_user_id_netdoc_id_fkey;

ALTER TABLE sidebar_folders RENAME TO space_folders;
ALTER TABLE sidebar_items RENAME TO space_items;

-- Adapt space_folders
ALTER TABLE space_folders
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE;

DO $$ BEGIN
    ALTER TABLE space_folders ADD CONSTRAINT folder_has_owner
        CHECK (user_id IS NOT NULL OR space_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Adapt space_items: add space_id, clean orphans, rename column
ALTER TABLE space_items
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE;

-- Add folder_id if missing
ALTER TABLE space_items ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES space_folders(id) ON DELETE SET NULL;

-- Clean orphaned items (comments and DMs already deleted from netdoc)
DELETE FROM space_items WHERE netdoc_id IN (SELECT id FROM comment_ids);
DELETE FROM space_items WHERE netdoc_id IN (SELECT id FROM dm_netdoc_ids);

ALTER TABLE space_items RENAME COLUMN netdoc_id TO genus_id;

DO $$ BEGIN
    ALTER TABLE space_items ADD CONSTRAINT item_has_owner
        CHECK (user_id IS NOT NULL OR space_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Move existing saved items into user's collection space
UPDATE space_items si
SET space_id = (
    SELECT s.id FROM spaces s
    WHERE s.monarch_id = si.user_id AND s.is_collection = TRUE LIMIT 1
)
WHERE si.space_id IS NULL AND si.user_id IS NOT NULL;

-- ============================================================================
-- PHASE 14: Migrate notifications
-- ============================================================================

INSERT INTO genus_notifications (user_id, genus_id, created_at)
SELECT nn.user_id, nn.netdoc_id, nn.created_at
FROM netdoc_notifications nn
WHERE nn.netdoc_id IN (SELECT id FROM genus)
ON CONFLICT DO NOTHING;

ALTER TABLE notifications RENAME COLUMN netdoc_id TO genus_id;
ALTER TABLE notifications DROP COLUMN IF EXISTS author_id;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_netdoc_id_fkey;
DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT notifications_genus_id_fkey
        FOREIGN KEY (genus_id) REFERENCES genus(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- PHASE 15: Repoint profile.homepage FK from netdoc(id) → genus(id), rename to gallery
-- ============================================================================

ALTER TABLE profile DROP CONSTRAINT IF EXISTS profile_homepage_fkey;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'profile' AND column_name = 'homepage') THEN
        ALTER TABLE profile RENAME COLUMN homepage TO gallery;
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'profile' AND column_name = 'gallery') THEN
        ALTER TABLE profile ADD COLUMN gallery TEXT COLLATE case_insensitive;
    END IF;
END $$;

ALTER TABLE profile ADD CONSTRAINT profile_gallery_fkey
    FOREIGN KEY (gallery) REFERENCES genus(id);

-- ============================================================================
-- PHASE 16: Alter netdoc — strip moved columns, add genus FK
-- ============================================================================

-- Drop old CHECK constraints before removing columns they reference
ALTER TABLE netdoc DROP CONSTRAINT IF EXISTS topic_only_for_chat;
ALTER TABLE netdoc DROP CONSTRAINT IF EXISTS users_can_change_topic_only_for_chat;
ALTER TABLE netdoc DROP CONSTRAINT IF EXISTS status_message_requires_null_creator;

ALTER TABLE netdoc DROP COLUMN IF EXISTS name;
ALTER TABLE netdoc DROP COLUMN IF EXISTS creator_id;
ALTER TABLE netdoc DROP COLUMN IF EXISTS is_unlisted;
ALTER TABLE netdoc DROP COLUMN IF EXISTS created_at;
ALTER TABLE netdoc DROP COLUMN IF EXISTS is_chat;
ALTER TABLE netdoc DROP COLUMN IF EXISTS topic;
ALTER TABLE netdoc DROP COLUMN IF EXISTS users_can_change_topic;

DO $$ BEGIN
    ALTER TABLE netdoc ADD CONSTRAINT netdoc_id_fkey
        FOREIGN KEY (id) REFERENCES genus(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- PHASE 17: Create jackets for each space
-- Profile jackets: list all user-created netdocs (minus gallery)
-- Collection jackets: list all space_items
-- Regular jackets: empty
-- Non-profile jackets get no companion chat, comment mode = whitelist
-- ============================================================================

DO $$
DECLARE
    s RECORD;
    jacket_genus_id TEXT;
    jacket_content TEXT;
BEGIN
    FOR s IN SELECT id, name, monarch_id, is_profile, is_collection FROM spaces LOOP
        jacket_genus_id := find_earliest_genus_id();

        -- Create genus for jacket (parented to its space)
        INSERT INTO genus (id, name, creator_id, space_id, is_unlisted)
        VALUES (jacket_genus_id, s.name, s.monarch_id, s.id, TRUE);

        IF s.is_profile THEN
            SELECT string_agg(link, E'\n' ORDER BY ca) INTO jacket_content
            FROM (
                SELECT '/netdoc/' || g.id AS link, g.created_at AS ca
                FROM genus g
                JOIN netdoc n ON n.id = g.id
                WHERE g.creator_id = s.monarch_id
                  AND n.is_jacket = FALSE
                  AND g.id != COALESCE((SELECT gallery FROM profile WHERE id = s.monarch_id), '')
            ) sub;
        ELSIF s.is_collection THEN
            SELECT string_agg(link, E'\n' ORDER BY ca) INTO jacket_content
            FROM (
                SELECT '/netdoc/' || si.genus_id AS link, si.created_at AS ca
                FROM space_items si
                WHERE si.space_id = s.id
            ) sub;
        ELSE
            jacket_content := '';
        END IF;

        -- Create jacket netdoc
        INSERT INTO netdoc (id, content, is_jacket)
        VALUES (jacket_genus_id, COALESCE(jacket_content, ''), TRUE);

        -- Create companion chat for profile jackets only
        INSERT INTO chat (id, is_standalone, updated_at)
        VALUES (jacket_genus_id, FALSE, NOW());

        IF NOT s.is_profile THEN
            DELETE FROM chat WHERE id = jacket_genus_id;
            UPDATE genus SET perms_mode_comment = 'whitelist' WHERE id = jacket_genus_id;
        END IF;

        UPDATE spaces SET jacket = jacket_genus_id WHERE id = s.id;
    END LOOP;
END $$;

-- ============================================================================
-- PHASE 18: Drop old tables and system users
-- ============================================================================

DROP TABLE IF EXISTS netdoc_notifications CASCADE;
DROP TABLE IF EXISTS netdoc_comment CASCADE;
DROP TABLE IF EXISTS netdoc_permission CASCADE;

-- Remove old system users that no longer exist in new schema
DELETE FROM profile WHERE id = '00000000-0000-0000-0000-000000000001';  -- anonymous
DELETE FROM profile WHERE id = '00000000-0000-0000-0000-000000000002';  -- everyone

DROP FUNCTION IF EXISTS find_earliest_netdoc_id();
DROP FUNCTION IF EXISTS create_user_homepage();
DROP FUNCTION IF EXISTS auto_generate_netdoc_id();

DROP SEQUENCE IF EXISTS netdoc_id_seq;

-- ============================================================================
-- PHASE 19: Indexes
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_spaces_monarch ON spaces(monarch_id);
CREATE INDEX IF NOT EXISTS idx_spaces_profile ON spaces(monarch_id, is_profile) WHERE is_profile = TRUE;
CREATE INDEX IF NOT EXISTS idx_spaces_collection ON spaces(monarch_id, is_collection) WHERE is_collection = TRUE;
CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);
CREATE INDEX IF NOT EXISTS idx_space_permission_space ON space_permission(space_id);
CREATE INDEX IF NOT EXISTS idx_space_permission_user ON space_permission(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_permission_lookup ON space_permission(space_id, permission_type, user_id);
CREATE INDEX IF NOT EXISTS idx_user_space_subscriptions_user_order ON user_space_subscriptions(user_id, order_key);
CREATE INDEX IF NOT EXISTS idx_genus_creator ON genus(creator_id);
CREATE INDEX IF NOT EXISTS idx_genus_space ON genus(space_id);
CREATE INDEX IF NOT EXISTS idx_genus_permission_genus ON genus_permission(genus_id);
CREATE INDEX IF NOT EXISTS idx_genus_permission_user ON genus_permission(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_genus_permission_type ON genus_permission(permission_type);
CREATE INDEX IF NOT EXISTS idx_genus_permission_lookup ON genus_permission(genus_id, permission_type, user_id);
CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_space ON genus_permission_frozen(frozen_by_space_id);
CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_user ON genus_permission_frozen(user_id);
CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_genus ON genus_permission_frozen(genus_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_chat ON chat_message(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_created ON chat_message(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_message_chat_created ON chat_message(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_standalone ON chat(is_standalone) WHERE is_standalone = TRUE;
CREATE INDEX IF NOT EXISTS idx_genus_notifications_user ON genus_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_message_conversation_created ON dm_message(conversation_id, created_at);

DROP INDEX IF EXISTS idx_sidebar_netdoc;
CREATE INDEX IF NOT EXISTS idx_sidebar_genus ON space_items(genus_id);
DROP INDEX IF EXISTS idx_dm_message_created;

-- ============================================================================
-- PHASE 20: Sync sequences and clean up temp tables
-- ============================================================================

SELECT setval('genus_id_seq',
    GREATEST(
        COALESCE((SELECT MAX(base32_to_int(id)) FROM genus), 1),
        2
    ),
    true
);

DROP TABLE IF EXISTS comment_roots;
DROP TABLE IF EXISTS comment_ids;
DROP TABLE IF EXISTS dm_netdoc_ids;

-- ============================================================================
-- PHASE 21: Verification
-- ============================================================================

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM netdoc n WHERE NOT EXISTS (SELECT 1 FROM genus WHERE id = n.id)) THEN
        RAISE WARNING 'FIXUP NEEDED: Some netdocs lack a genus row';
    END IF;

    IF EXISTS (SELECT 1 FROM genus g WHERE NOT EXISTS (SELECT 1 FROM chat WHERE id = g.id)) THEN
        RAISE WARNING 'FIXUP NEEDED: Some genera lack a chat row';
    END IF;

    IF EXISTS (
        SELECT 1 FROM profile p
        WHERE p.id NOT IN (
            '00000000-0000-0000-0000-000000000000'::uuid,
            '99999999-9999-9999-9999-999999999999'::uuid
        )
        AND NOT EXISTS (SELECT 1 FROM spaces WHERE monarch_id = p.id AND is_profile = TRUE)
    ) THEN
        RAISE WARNING 'FIXUP NEEDED: Some users lack a profile space';
    END IF;

    RAISE NOTICE 'Migration complete. Now load init.sql, jacket.sql, create.sql, perms_triggers.sql, etc.';
END $$;

COMMIT;

-- ============================================================================
-- DONE. Load order after migration:
--   1. init.sql          (tables + helpers + triggers)
--   2. perms_triggers.sql (permission trigger bindings)
--   3. jacket.sql         (jacket helpers + triggers)
--   4. reacts.sql         (message reactions)
--   5. create.sql         (atomic create functions)
--   6. subs_and_notifs.sql (notification triggers)
--   7. seed.sql           (system users via create_profile)
-- ============================================================================