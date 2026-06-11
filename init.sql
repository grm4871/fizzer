--
-- Netaris Database Initialization Script
--
-- Architecture:
--   genus is the base entity. Every netdoc and chat inherits from a genus.
--   genus owns: id, name, creator, space, read perms, visibility.
--   netdoc adds: content, yjs_state, write perms, jacket flag.
--   chat adds: comment perms, topic, standalone flag.
--
-- Every genus gets a chat (companion by default).
-- Some genera also get a netdoc (documents).
-- Standalone chats are genera with only a chat, no netdoc.
--
-- Permission hierarchy (all on genus_permission, single table):
--   write (netdoc-only) > comment (chat-only) > read (both)
--   Grant cascades down, revoke cascades up.
--   Owner can revoke their own comment but not read or write.
--
-- Space permissions act as a CEILING for genus permissions.
--   Profile spaces are exempt: genus perms can override upward.
--   Collection spaces are always private to owner.
--   Regular spaces enforce ceiling: genus perms cannot exceed space perms.
--
-- Spaces:
--   Every genus belongs to a space via genus.space_id.
--   Collection spaces cannot be parents (enforced by trigger).
--   Collection spaces link to genera via space_items.
--
-- This script will run automatically when the container is first created

-- Create case-insensitive collation for IDs
CREATE COLLATION IF NOT EXISTS case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false);

-- Create the users/profiles table (gallery field added later to avoid circular dependency)
CREATE TABLE IF NOT EXISTS profile (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL CHECK (username ~ '^[a-zA-Z0-9_]{1,15}$'),
    display_name TEXT NOT NULL,
    password TEXT NOT NULL,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    color VARCHAR(6) DEFAULT 'd2b34e',
    settings JSON DEFAULT '{}',
    is_admin BOOLEAN DEFAULT FALSE,
    folder_dialogue INTEGER NOT NULL DEFAULT 0
);

-- perms_mode enum and trigger functions are in sql/perms.sql (01-perms.sql)

-- ============================================================================
-- SPACES
-- ============================================================================

-- Spaces are shareable collections that work like a user's sidebar.
-- Users get a profile space (public) and a saved/collection space (private).
-- Users can also create/join shared spaces.
-- Collection spaces link to genera via space_items but cannot parent them.
--
-- Roles: owner (creator), custodian (max 2, co-admin), member.
-- deleted_creator: set when owner deletes their account. Space persists.
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

-- Space membership (roles: 'monarch', 'custodian', 'member')
CREATE TABLE IF NOT EXISTS space_members (
    id BIGSERIAL PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (space_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_spaces_monarch ON spaces(monarch_id);
CREATE INDEX IF NOT EXISTS idx_spaces_profile ON spaces(monarch_id, is_profile) WHERE is_profile = TRUE;
CREATE INDEX IF NOT EXISTS idx_spaces_collection ON spaces(monarch_id, is_collection) WHERE is_collection = TRUE;
CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members(space_id);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);

-- Space permissions (same shape as genus_permission)
CREATE TABLE IF NOT EXISTS space_permission (
    id BIGSERIAL PRIMARY KEY,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    permission_type VARCHAR(50) NOT NULL, -- 'read', 'write', 'comment'
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    is_blacklist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (space_id, permission_type, user_id, is_blacklist)
);

CREATE INDEX IF NOT EXISTS idx_space_permission_space ON space_permission(space_id);
CREATE INDEX IF NOT EXISTS idx_space_permission_user ON space_permission(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_space_permission_lookup ON space_permission(space_id, permission_type, user_id);

-- User space subscriptions (which spaces appear in a user's sidebar)
CREATE TABLE IF NOT EXISTS user_space_subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    order_key INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, space_id)
);

CREATE INDEX IF NOT EXISTS idx_user_space_subscriptions_user_order ON user_space_subscriptions(user_id, order_key);

-- Sidebar folders for organizing within spaces
CREATE TABLE IF NOT EXISTS space_folders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
    parent_folder_id UUID REFERENCES space_folders(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    is_open BOOLEAN DEFAULT true,
    order_key INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, parent_folder_id, order_key),
    CONSTRAINT folder_has_owner CHECK (user_id IS NOT NULL OR space_id IS NOT NULL)
);

-- Sidebar items link to genera (saved docs/chats)
CREATE TABLE IF NOT EXISTS space_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    space_id TEXT REFERENCES spaces(id) ON DELETE CASCADE,
    genus_id TEXT COLLATE case_insensitive NOT NULL,
    folder_id UUID REFERENCES space_folders(id) ON DELETE SET NULL,
    order_key INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, folder_id, order_key),
    UNIQUE (user_id, genus_id),
    CONSTRAINT item_has_owner CHECK (user_id IS NOT NULL OR space_id IS NOT NULL)
);

-- Record TOS acceptance
CREATE TABLE IF NOT EXISTS tos_acceptance (
   id BIGSERIAL PRIMARY KEY,
   profile_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
   tos_version VARCHAR(50) NOT NULL,
   accepted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
   ip_address VARCHAR(45)
);

-- ============================================================================
-- GENUS (base entity — netdocs and chats inherit from this)
-- ============================================================================

-- Sequence for genus ID auto-increment (starts at 2 since 0 and 1 are reserved)
CREATE SEQUENCE IF NOT EXISTS genus_id_seq START WITH 2;

-- Function to convert integer to base-32 readable (Crockford's base32: excludes I, L, O, U)
CREATE OR REPLACE FUNCTION int_to_base32(num BIGINT) RETURNS TEXT AS $$
DECLARE
    base32_chars TEXT := '0123456789abcdefghjkmnpqrstvwxyz';
    result TEXT := '';
    remainder INT;
BEGIN
    IF num = 0 THEN
        RETURN '0';
    END IF;
    WHILE num > 0 LOOP
        remainder := num % 32;
        result := substring(base32_chars from (remainder + 1) for 1) || result;
        num := num / 32;
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to convert base-32 readable string back to integer
CREATE OR REPLACE FUNCTION base32_to_int(str TEXT) RETURNS BIGINT AS $$
DECLARE
    base32_chars TEXT COLLATE "C" := '0123456789abcdefghjkmnpqrstvwxyz';
    result BIGINT := 0;
    i INT;
    c TEXT;
    pos INT;
BEGIN
    str := lower(str);
    FOR i IN 1..length(str) LOOP
        c := substr(str, i, 1);
        pos := strpos(base32_chars, c COLLATE "C") - 1;
        IF pos < 0 THEN
            RETURN NULL;
        END IF;
        result := result * 32 + pos;
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Sequence for space ID auto-increment
CREATE SEQUENCE IF NOT EXISTS space_id_seq START WITH 1;

-- Function to find the earliest available gap in space IDs
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

-- Function to find the earliest available gap in genus IDs
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

-- The base entity. Every netdoc and chat hangs off a genus.
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

CREATE INDEX IF NOT EXISTS idx_genus_creator ON genus(creator_id);
CREATE INDEX IF NOT EXISTS idx_genus_space ON genus(space_id);

-- ============================================================================
-- NETDOC (document layer — hangs off genus)
-- ============================================================================

CREATE TABLE IF NOT EXISTS netdoc (
    id TEXT COLLATE case_insensitive PRIMARY KEY REFERENCES genus(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    yjs_state BYTEA,
    hide_history_from_non_editors BOOLEAN NOT NULL DEFAULT FALSE,
    status_message BOOLEAN NOT NULL DEFAULT FALSE,
    is_jacket BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add gallery field to profile now that genus exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'profile' AND column_name = 'gallery') THEN
        ALTER TABLE profile ADD COLUMN gallery TEXT COLLATE case_insensitive REFERENCES genus(id);
    END IF;
END $$;

-- ============================================================================
-- CHAT (conversation layer — hangs off genus)
-- Every genus gets a chat. Companion chats pair with a netdoc.
-- Standalone chats have no netdoc.
-- ============================================================================

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

CREATE INDEX IF NOT EXISTS idx_chat_message_chat ON chat_message(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_message_created ON chat_message(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_message_chat_created ON chat_message(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_standalone ON chat(is_standalone) WHERE is_standalone = TRUE;

-- ============================================================================
-- GENUS PERMISSIONS (single table for all permission types)
-- permission_type: 'read', 'write' (netdoc), 'comment' (chat)
-- ============================================================================

CREATE TABLE IF NOT EXISTS genus_permission (
    id BIGSERIAL PRIMARY KEY,
    genus_id TEXT COLLATE case_insensitive NOT NULL REFERENCES genus(id) ON DELETE CASCADE,
    permission_type VARCHAR(50) NOT NULL, -- 'read', 'write', 'comment'
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    is_blacklist BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (genus_id, permission_type, user_id, is_blacklist)
);

CREATE INDEX IF NOT EXISTS idx_genus_permission_genus ON genus_permission(genus_id);
CREATE INDEX IF NOT EXISTS idx_genus_permission_user ON genus_permission(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_genus_permission_type ON genus_permission(permission_type);
CREATE INDEX IF NOT EXISTS idx_genus_permission_lookup ON genus_permission(genus_id, permission_type, user_id);

-- ============================================================================
-- FROZEN GENUS PERMISSIONS
-- When space restricts access, genus perms move here.
-- Restored when space re-permits access.
-- frozen_by_space_id tracks which space caused the freeze.
-- ============================================================================

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

CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_space ON genus_permission_frozen(frozen_by_space_id);
CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_user ON genus_permission_frozen(user_id);
CREATE INDEX IF NOT EXISTS idx_genus_perm_frozen_genus ON genus_permission_frozen(genus_id);

-- ============================================================================
-- VERSION HISTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS netdoc_version (
    id BIGSERIAL PRIMARY KEY,
    netdoc_id TEXT COLLATE case_insensitive NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    title VARCHAR(500) NOT NULL,
    author UUID NOT NULL REFERENCES profile(id)
);

-- ============================================================================
-- DIRECT MESSAGES (self-contained, not genus-based)
-- ============================================================================

CREATE TABLE IF NOT EXISTS dm_conversation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id_1 UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    user_id_2 UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id_1, user_id_2),
    CHECK (user_id_1 < user_id_2)
);

CREATE TABLE IF NOT EXISTS dm_message (
    id BIGSERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES dm_conversation(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    content TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- DOCUMENT VIEWS (popularity tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS netdoc_view (
    id BIGSERIAL PRIMARY KEY,
    netdoc_id TEXT COLLATE case_insensitive NOT NULL REFERENCES netdoc(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (netdoc_id, viewer_id)
);

-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================

-- Genus notification subscriptions
CREATE TABLE IF NOT EXISTS genus_notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    genus_id TEXT COLLATE case_insensitive NOT NULL REFERENCES genus(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, genus_id)
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    genus_id TEXT COLLATE case_insensitive REFERENCES genus(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    content TEXT,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_dm_conversation_users ON dm_conversation(user_id_1, user_id_2);
CREATE INDEX IF NOT EXISTS idx_dm_message_conversation ON dm_message(conversation_id);
CREATE INDEX IF NOT EXISTS idx_dm_message_sender ON dm_message(sender_id);
CREATE INDEX IF NOT EXISTS idx_dm_message_created ON dm_message(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_folders_user ON space_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON space_folders(parent_folder_id) WHERE parent_folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sidebar_user_order ON space_items(user_id, order_key);
CREATE INDEX IF NOT EXISTS idx_sidebar_genus ON space_items(genus_id);
CREATE INDEX IF NOT EXISTS idx_sidebar_folder ON space_items(folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_username ON profile(username);

CREATE INDEX IF NOT EXISTS idx_netdoc_view_netdoc ON netdoc_view(netdoc_id);
CREATE INDEX IF NOT EXISTS idx_netdoc_view_time ON netdoc_view(viewed_at);

CREATE INDEX IF NOT EXISTS idx_tos_profile ON tos_acceptance(profile_id);
CREATE INDEX IF NOT EXISTS idx_tos_version ON tos_acceptance(tos_version);

CREATE INDEX IF NOT EXISTS idx_genus_notifications_user ON genus_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

-- ============================================================================
-- TRIGGER: Auto-generate genus IDs
-- ============================================================================

CREATE OR REPLACE FUNCTION auto_generate_genus_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.id IS NULL OR NEW.id = '' THEN
        NEW.id := find_earliest_genus_id();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_generate_genus_id ON genus;
CREATE TRIGGER trigger_auto_generate_genus_id
    BEFORE INSERT ON genus
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_genus_id();

-- ============================================================================
-- TRIGGER: Prevent collection spaces from parenting genera
-- Collection spaces link to genera via space_items only.
-- ============================================================================

CREATE OR REPLACE FUNCTION prevent_collection_as_parent()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.space_id IS NOT NULL THEN
        -- Jackets are exempt — they must be parented to their space
        IF current_setting('jacket.creating', true) = 'true' THEN
            RETURN NEW;
        END IF;
        IF EXISTS (SELECT 1 FROM netdoc WHERE id = NEW.id AND is_jacket = TRUE) THEN
            RETURN NEW;
        END IF;
        IF EXISTS (SELECT 1 FROM spaces WHERE id = NEW.space_id AND is_collection = TRUE) THEN
            RAISE EXCEPTION 'Collection spaces cannot be the parent of genera (space_id: %)', NEW.space_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prevent_collection_parent ON genus;
CREATE TRIGGER trigger_prevent_collection_parent
    BEFORE INSERT OR UPDATE OF space_id ON genus
    FOR EACH ROW
    EXECUTE FUNCTION prevent_collection_as_parent();

-- ============================================================================
-- TRIGGER: Only profile owner can create genera in their profile space
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_profile_space_ownership()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.space_id IS NOT NULL THEN
        IF EXISTS (
            SELECT 1 FROM spaces
            WHERE id = NEW.space_id
              AND is_profile = TRUE
              AND monarch_id != NEW.creator_id
        ) THEN
            RAISE EXCEPTION 'Only the profile owner can create genera in their profile space';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_enforce_profile_space_ownership ON genus;
CREATE TRIGGER trigger_enforce_profile_space_ownership
    BEFORE INSERT OR UPDATE OF space_id ON genus
    FOR EACH ROW
    EXECUTE FUNCTION enforce_profile_space_ownership();

-- ============================================================================
-- TRIGGER: Auto-create companion chat on netdoc INSERT
-- Every netdoc gets a companion chat (is_standalone=FALSE).
-- ============================================================================

CREATE OR REPLACE FUNCTION create_companion_chat()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM chat WHERE id = NEW.id) THEN
        INSERT INTO chat (id, is_standalone, updated_at)
        VALUES (NEW.id, FALSE, NOW());
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_companion_chat ON netdoc;
CREATE TRIGGER trigger_create_companion_chat
    AFTER INSERT ON netdoc
    FOR EACH ROW
    EXECUTE FUNCTION create_companion_chat();

-- ============================================================================
-- HELPER: create_space_for_user
-- Pure function, no trigger context. Creates a space + monarch membership.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_space_for_user(
    p_user_id UUID,
    p_display_name TEXT,
    p_is_profile BOOLEAN,
    p_is_collection BOOLEAN
) RETURNS TEXT AS $$
DECLARE
    new_space_id TEXT;
    space_name TEXT;
    read_mode perms_mode;
    comment_mode perms_mode;
BEGIN
    IF p_is_profile THEN
        space_name := p_display_name || '''s Profile';
        read_mode := 'blacklist';
        comment_mode := 'blacklist';
    ELSE
        space_name := p_display_name || '''s Saved';
        read_mode := 'whitelist';
        comment_mode := 'whitelist';
    END IF;

    INSERT INTO spaces (id, monarch_id, name, description,
                        is_profile, is_collection,
                        perms_mode_read, perms_mode_comment, perms_mode_write)
    VALUES (find_earliest_space_id(), p_user_id, space_name, '',
            p_is_profile, p_is_collection,
            read_mode, comment_mode, 'whitelist')
    RETURNING id INTO new_space_id;

    INSERT INTO space_members (space_id, user_id, role)
    VALUES (new_space_id, p_user_id, 'monarch');

    RETURN new_space_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER: create_gallery_for_user
-- Pure function, no trigger context. Creates gallery genus + netdoc + chat +
-- permissions, sets profile.gallery. Self-contained: does not rely on triggers.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_gallery_for_user(
    p_user_id UUID,
    p_username TEXT,
    p_space_id TEXT
) RETURNS TEXT AS $$
DECLARE
    new_genus_id TEXT;
BEGIN
    -- Explicit ID — works whether auto_generate_genus_id trigger is active or not
    INSERT INTO genus (id, name, creator_id, space_id)
    VALUES (find_earliest_genus_id(), p_username || '''s Homepage', p_user_id, p_space_id)
    RETURNING id INTO new_genus_id;

    -- Set gallery BEFORE netdoc insert so jacket trigger can see it
    UPDATE profile SET gallery = new_genus_id WHERE id = p_user_id;

    INSERT INTO netdoc (id, content) VALUES (new_genus_id, '');

    -- Companion chat — idempotent with create_companion_chat trigger
    INSERT INTO chat (id, is_standalone, updated_at)
    VALUES (new_genus_id, FALSE, NOW())
    ON CONFLICT DO NOTHING;

    -- Creator permissions
    INSERT INTO genus_permission (genus_id, permission_type, user_id)
    VALUES
        (new_genus_id, 'read', p_user_id),
        (new_genus_id, 'write', p_user_id)
    ON CONFLICT DO NOTHING;

    RETURN new_genus_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Auto-create personal spaces and gallery for new users
-- Thin wrapper — calls helpers. Used for ad-hoc profile INSERTs.
-- create_profile() bypasses this and calls helpers directly.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_user_spaces_and_gallery()
RETURNS TRIGGER AS $$
DECLARE
    profile_space_id TEXT;
BEGIN
    profile_space_id := create_space_for_user(NEW.id, NEW.display_name, TRUE, FALSE);
    PERFORM create_space_for_user(NEW.id, NEW.display_name, FALSE, TRUE);
    PERFORM create_gallery_for_user(NEW.id, NEW.username, profile_space_id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_user_spaces_and_gallery ON profile;
CREATE TRIGGER trigger_create_user_spaces_and_gallery
    AFTER INSERT ON profile
    FOR EACH ROW
    EXECUTE FUNCTION create_user_spaces_and_gallery();

-- Set the sequence to start after existing IDs
SELECT setval('genus_id_seq', 2, false);

-- ============================================================================
-- FUNCTION: update_chat_topic(chat_id, user_id, new_topic)
-- Returns the new topic on success, NULL if the user lacks permission.
-- ============================================================================
CREATE OR REPLACE FUNCTION update_chat_topic(p_chat_id TEXT, p_user_id UUID, p_new_topic VARCHAR(390))
RETURNS VARCHAR(390) AS $$
DECLARE
    v_creator_id UUID;
    v_can_change BOOLEAN;
BEGIN
    SELECT g.creator_id, c.users_can_change_topic
    INTO v_creator_id, v_can_change
    FROM chat c
    JOIN genus g ON g.id = c.id
    WHERE c.id = p_chat_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_creator_id != p_user_id AND NOT v_can_change THEN
        -- Also allow custodians
        IF NOT EXISTS (
            SELECT 1 FROM genus g
            JOIN space_members sm ON sm.space_id = g.space_id
            WHERE g.id = p_chat_id AND sm.user_id = p_user_id AND sm.role = 'custodian'
        ) THEN
            RETURN NULL;
        END IF;
    END IF;

    UPDATE chat SET topic = p_new_topic WHERE id = p_chat_id;
    RETURN p_new_topic;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- BUSINESS RULE CONSTRAINTS
-- ============================================================================

-- Prevent monarch from unsubscribing from their own space
CREATE OR REPLACE FUNCTION prevent_monarch_unsubscribe()
RETURNS TRIGGER AS $$
DECLARE
    space_monarch_id UUID;
BEGIN
    SELECT monarch_id INTO space_monarch_id
    FROM spaces
    WHERE id = OLD.space_id;

    IF space_monarch_id = OLD.user_id THEN
        RAISE EXCEPTION 'MONARCH_CANNOT_UNSUBSCRIBE: Cannot unsubscribe from a space you reign over';
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prevent_monarch_unsubscribe ON user_space_subscriptions;
CREATE TRIGGER trigger_prevent_monarch_unsubscribe
    BEFORE DELETE ON user_space_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_monarch_unsubscribe();

-- Auto-create version when netdoc content changes
CREATE OR REPLACE FUNCTION auto_create_netdoc_version()
RETURNS TRIGGER AS $$
DECLARE
    genus_name TEXT;
    last_editor UUID;
BEGIN
    -- Only create version if content actually changed
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        SELECT name INTO genus_name
        FROM genus
        WHERE id = OLD.id;

        SELECT creator_id INTO last_editor
        FROM genus
        WHERE id = OLD.id;

        INSERT INTO netdoc_version (netdoc_id, content, title, author, created_at)
        VALUES (
            OLD.id,
            OLD.content,
            COALESCE(genus_name, 'Untitled'),
            last_editor,
            NOW()
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_create_netdoc_version ON netdoc;
CREATE TRIGGER trigger_auto_create_netdoc_version
    BEFORE UPDATE OF content ON netdoc
    FOR EACH ROW
    EXECUTE FUNCTION auto_create_netdoc_version();

-- Permission trigger bindings are in sql/perms_triggers.sql
-- Jacket sync triggers are in sql/jacket.sql
-- Notification/subscription triggers are in sql/subs_and_notifs.sql