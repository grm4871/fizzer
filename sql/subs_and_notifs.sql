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

CREATE INDEX IF NOT EXISTS idx_genus_notifications_user ON genus_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);

-- Enabling notifs auto-subscribes to saved space
CREATE OR REPLACE FUNCTION cascade_notifs_adds_sub()
RETURNS TRIGGER AS $$
DECLARE
    saved_space_id TEXT;
    max_order INT;
BEGIN
    SELECT id INTO saved_space_id FROM spaces
    WHERE monarch_id = NEW.user_id AND is_collection = TRUE
    LIMIT 1;

    IF saved_space_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM space_items
            WHERE space_id = saved_space_id AND genus_id = NEW.genus_id
        ) THEN
            SELECT COALESCE(MAX(order_key), -1) INTO max_order
            FROM space_items WHERE space_id = saved_space_id;

            INSERT INTO space_items (space_id, genus_id, order_key)
            VALUES (saved_space_id, NEW.genus_id, max_order + 1);
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notifs_adds_sub ON genus_notifications;
CREATE TRIGGER trg_notifs_adds_sub
    AFTER INSERT ON genus_notifications
    FOR EACH ROW
    EXECUTE FUNCTION cascade_notifs_adds_sub();

-- Unsubscribing from saved space removes notifications
CREATE OR REPLACE FUNCTION cascade_unsub_removes_notifs()
RETURNS TRIGGER AS $$
DECLARE
    monarch_id UUID;
BEGIN
    SELECT s.monarch_id INTO monarch_id FROM spaces s
    WHERE s.id = OLD.space_id AND s.is_collection = TRUE;

    IF monarch_id IS NOT NULL THEN
        DELETE FROM genus_notifications
        WHERE user_id = monarch_id AND genus_id = OLD.genus_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_unsub_removes_notifs ON space_items;
CREATE TRIGGER trg_unsub_removes_notifs
    AFTER DELETE ON space_items
    FOR EACH ROW
    EXECUTE FUNCTION cascade_unsub_removes_notifs();

-- ============================================================================
