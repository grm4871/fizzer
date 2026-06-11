-- ============================================================================
-- JACKET SYNC: automatic jacket content management (refactored)
--
-- Profile jackets track everything a user creates (/netdoc/ID or /chat/ID).
-- Space jackets track genera whose space_id points to the space.
-- Collection (saved) space jackets track genera added via space_items.
-- Jacket content is user-editable but required links are enforced.
--
-- CONSTRAINTS:
-- 1. Everything a profile makes goes in profile jacket regardless of parent space
-- 2. Collection spaces can't be parent to a doc/chat (enforced elsewhere)
-- ============================================================================

-- ============================================================================
-- HELPER: create_jacket_for_space
-- Pure function, no trigger context. Creates jacket genus + netdoc for a space.
-- Called by create_profile() directly and by trigger wrapper at runtime.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_jacket_for_space(
    p_space_id TEXT,
    p_monarch_id UUID,
    p_is_profile BOOLEAN
) RETURNS TEXT AS $$
DECLARE
    jacket_genus_id TEXT;
    jacket_content TEXT;
    space_name TEXT;
BEGIN
    -- For profile spaces, populate jacket with existing user-created netdocs
    IF p_is_profile THEN
        SELECT string_agg(
            '/netdoc/' || g.id,
            E'\n' ORDER BY g.created_at
        )
        INTO jacket_content
        FROM genus g
        JOIN netdoc n ON n.id = g.id
        WHERE g.creator_id = p_monarch_id
          AND n.is_jacket = FALSE
          AND g.id != COALESCE((SELECT gallery FROM profile WHERE id = p_monarch_id), '');
    ELSE
        jacket_content := '';
    END IF;

    SELECT name INTO space_name FROM spaces WHERE id = p_space_id;

    -- Create genus for the jacket, parented to its space
    -- Set flag so prevent_collection_as_parent exempts this insert
    PERFORM set_config('jacket.creating', 'true', true);
    INSERT INTO genus (id, name, creator_id, space_id, is_unlisted)
    VALUES (find_earliest_genus_id(), space_name, p_monarch_id, p_space_id, true)
    RETURNING id INTO jacket_genus_id;
    PERFORM set_config('jacket.creating', '', true);

    -- Create jacket netdoc
    INSERT INTO netdoc (id, content, is_jacket)
    VALUES (jacket_genus_id, COALESCE(jacket_content, ''), true);

    -- Companion chat — needed when triggers are disabled (create_profile path)
    -- ON CONFLICT: no-op when create_companion_chat trigger is active
    INSERT INTO chat (id, is_standalone, updated_at)
    VALUES (jacket_genus_id, FALSE, NOW())
    ON CONFLICT DO NOTHING;

    -- Only profile space jackets get companion chats
    -- Non-profile jackets: remove chat and disable comment perms
    IF NOT p_is_profile THEN
        DELETE FROM chat WHERE id = jacket_genus_id;
        UPDATE genus SET perms_mode_comment = 'whitelist' WHERE id = jacket_genus_id;
    END IF;

    UPDATE spaces SET jacket = jacket_genus_id WHERE id = p_space_id;

    RETURN jacket_genus_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Auto-create jacket for new spaces (thin wrapper)
-- ============================================================================

CREATE OR REPLACE FUNCTION create_space_jacket()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM create_jacket_for_space(NEW.id, NEW.monarch_id, NEW.is_profile);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_create_space_jacket ON spaces;
CREATE TRIGGER trigger_create_space_jacket
    AFTER INSERT ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION create_space_jacket();

-- ============================================================================
-- HELPER: Core function to append a link to a jacket
-- ============================================================================

CREATE OR REPLACE FUNCTION append_link_to_jacket(
    p_genus_id TEXT,
    p_link_prefix TEXT,  -- '/netdoc/' or '/chat/'
    p_jacket_id TEXT,
    p_skip_if_gallery BOOLEAN DEFAULT FALSE,
    p_creator_id UUID DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    link TEXT;
    jacket_content TEXT;
BEGIN
    -- Skip if this is the jacket itself
    IF p_genus_id = p_jacket_id THEN
        RETURN;
    END IF;

    -- Skip if the genus is itself a jacket
    IF EXISTS (SELECT 1 FROM netdoc WHERE id = p_genus_id AND is_jacket = TRUE) THEN
        RETURN;
    END IF;

    -- Skip if this is the user's gallery
    IF p_skip_if_gallery AND p_creator_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM profile WHERE id = p_creator_id AND gallery = p_genus_id) THEN
            RETURN;
        END IF;
    END IF;

    link := p_link_prefix || p_genus_id;

    -- Only append if not already present (check as full line, not substring)
    SELECT content INTO jacket_content FROM netdoc WHERE id = p_jacket_id;
    IF strpos(E'\n' || jacket_content || E'\n' COLLATE "C", E'\n' || link || E'\n') = 0 THEN
        UPDATE netdoc
        SET content = CASE WHEN content = '' THEN link ELSE content || E'\n' || link END,
            updated_at = NOW()
        WHERE id = p_jacket_id;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- HELPER: Core function to remove a link from a jacket
-- ============================================================================

CREATE OR REPLACE FUNCTION remove_link_from_jacket(
    p_genus_id TEXT,
    p_jacket_id TEXT
) RETURNS VOID AS $$
BEGIN
    UPDATE netdoc
    SET content = array_to_string(
        array_remove(
            array_remove(
                string_to_array(content, E'\n'),
                '/netdoc/' || p_genus_id
            ),
            '/chat/' || p_genus_id
        ),
        E'\n'
    ),
    updated_at = NOW()
    WHERE id = p_jacket_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FACTORY: Get profile jacket ID for a user
-- ============================================================================

CREATE OR REPLACE FUNCTION get_profile_jacket_id(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE
    jacket_id TEXT;
BEGIN
    SELECT s.jacket INTO jacket_id
    FROM spaces s
    WHERE s.monarch_id = p_user_id AND s.is_profile = TRUE
    LIMIT 1;

    RETURN jacket_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FACTORY: Get space jacket ID
-- ============================================================================

CREATE OR REPLACE FUNCTION get_space_jacket_id(p_space_id TEXT)
RETURNS TEXT AS $$
DECLARE
    jacket_id TEXT;
BEGIN
    SELECT s.jacket INTO jacket_id
    FROM spaces s
    WHERE s.id = p_space_id;

    RETURN jacket_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Append new netdoc to creator's profile jacket
-- Profile jacket = global index of everything the user has created.
-- ============================================================================

CREATE OR REPLACE FUNCTION append_netdoc_to_profile_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
    genus_rec RECORD;
BEGIN
    IF NEW.is_jacket THEN RETURN NEW; END IF;

    SELECT g.creator_id INTO genus_rec FROM genus g WHERE g.id = NEW.id;
    IF genus_rec.creator_id IS NULL THEN RETURN NEW; END IF;

    jacket_id := get_profile_jacket_id(genus_rec.creator_id);
    IF jacket_id IS NULL THEN RETURN NEW; END IF;

    PERFORM append_link_to_jacket(NEW.id, '/netdoc/', jacket_id, TRUE, genus_rec.creator_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_append_netdoc_to_profile_jacket ON netdoc;
CREATE TRIGGER trigger_append_netdoc_to_profile_jacket
    AFTER INSERT ON netdoc
    FOR EACH ROW
    EXECUTE FUNCTION append_netdoc_to_profile_jacket();

-- ============================================================================
-- TRIGGER: Append new netdoc to its parent space's jacket
-- ============================================================================

CREATE OR REPLACE FUNCTION append_netdoc_to_space_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
    genus_rec RECORD;
BEGIN
    IF NEW.is_jacket THEN RETURN NEW; END IF;

    SELECT g.space_id, g.creator_id INTO genus_rec FROM genus g WHERE g.id = NEW.id;
    IF genus_rec.space_id IS NULL THEN RETURN NEW; END IF;

    jacket_id := get_space_jacket_id(genus_rec.space_id);
    IF jacket_id IS NULL THEN RETURN NEW; END IF;

    PERFORM append_link_to_jacket(NEW.id, '/netdoc/', jacket_id, TRUE, genus_rec.creator_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_append_netdoc_to_space_jacket ON netdoc;
CREATE TRIGGER trigger_append_netdoc_to_space_jacket
    AFTER INSERT ON netdoc
    FOR EACH ROW
    EXECUTE FUNCTION append_netdoc_to_space_jacket();

-- ============================================================================
-- TRIGGER: Append new standalone chat to creator's profile jacket
-- Only standalone chats — companion chats are covered by the netdoc trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION append_chat_to_profile_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
    genus_rec RECORD;
BEGIN
    IF NOT NEW.is_standalone THEN RETURN NEW; END IF;
    -- On UPDATE, only fire when is_standalone just flipped to TRUE
    IF TG_OP = 'UPDATE' AND OLD.is_standalone THEN RETURN NEW; END IF;

    SELECT g.creator_id INTO genus_rec FROM genus g WHERE g.id = NEW.id;
    IF genus_rec.creator_id IS NULL THEN RETURN NEW; END IF;

    jacket_id := get_profile_jacket_id(genus_rec.creator_id);
    IF jacket_id IS NULL THEN RETURN NEW; END IF;

    PERFORM append_link_to_jacket(NEW.id, '/chat/', jacket_id, FALSE, genus_rec.creator_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_append_chat_to_profile_jacket ON chat;
CREATE TRIGGER trigger_append_chat_to_profile_jacket
    AFTER INSERT OR UPDATE ON chat
    FOR EACH ROW
    EXECUTE FUNCTION append_chat_to_profile_jacket();

-- ============================================================================
-- TRIGGER: Append new standalone chat to its parent space's jacket
-- ============================================================================

CREATE OR REPLACE FUNCTION append_chat_to_space_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
    genus_rec RECORD;
BEGIN
    IF NOT NEW.is_standalone THEN RETURN NEW; END IF;

    SELECT g.space_id INTO genus_rec FROM genus g WHERE g.id = NEW.id;
    IF genus_rec.space_id IS NULL THEN RETURN NEW; END IF;

    jacket_id := get_space_jacket_id(genus_rec.space_id);
    IF jacket_id IS NULL THEN RETURN NEW; END IF;

    PERFORM append_link_to_jacket(NEW.id, '/chat/', jacket_id, FALSE, NULL);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_append_chat_to_space_jacket ON chat;
CREATE TRIGGER trigger_append_chat_to_space_jacket
    AFTER INSERT ON chat
    FOR EACH ROW
    EXECUTE FUNCTION append_chat_to_space_jacket();

-- ============================================================================
-- TRIGGER: Append space_item to its space's jacket
-- Handles collection (saved) spaces — genera are linked, not parented.
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_space_item_to_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
    link_prefix TEXT;
    jacket_content TEXT;
    netdoc_link TEXT;
    chat_link TEXT;
BEGIN
    IF NEW.space_id IS NULL THEN RETURN NEW; END IF;

    jacket_id := get_space_jacket_id(NEW.space_id);
    IF jacket_id IS NULL OR jacket_id = NEW.genus_id THEN RETURN NEW; END IF;

    -- Determine link type: /netdoc/ if it has a netdoc, /chat/ if standalone chat
    IF EXISTS (SELECT 1 FROM netdoc WHERE id = NEW.genus_id) THEN
        link_prefix := '/netdoc/';
    ELSE
        link_prefix := '/chat/';
    END IF;

    -- Check if link already exists (either form, as full lines not substrings)
    SELECT content INTO jacket_content FROM netdoc WHERE id = jacket_id;
    netdoc_link := '/netdoc/' || NEW.genus_id;
    chat_link := '/chat/' || NEW.genus_id;

    IF strpos(E'\n' || jacket_content || E'\n' COLLATE "C", E'\n' || netdoc_link || E'\n') = 0
       AND strpos(E'\n' || jacket_content || E'\n' COLLATE "C", E'\n' || chat_link || E'\n') = 0 THEN
        PERFORM append_link_to_jacket(NEW.genus_id, link_prefix, jacket_id, FALSE, NULL);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_space_item_to_jacket ON space_items;
CREATE TRIGGER trigger_sync_space_item_to_jacket
    AFTER INSERT ON space_items
    FOR EACH ROW
    EXECUTE FUNCTION sync_space_item_to_jacket();

-- ============================================================================
-- TRIGGER: Remove space_item from its space's jacket
-- ============================================================================

CREATE OR REPLACE FUNCTION unsync_space_item_from_jacket()
RETURNS TRIGGER AS $$
DECLARE
    jacket_id TEXT;
BEGIN
    IF OLD.space_id IS NULL THEN RETURN OLD; END IF;

    jacket_id := get_space_jacket_id(OLD.space_id);
    IF jacket_id IS NULL THEN RETURN OLD; END IF;

    PERFORM remove_link_from_jacket(OLD.genus_id, jacket_id);

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_unsync_space_item_from_jacket ON space_items;
CREATE TRIGGER trigger_unsync_space_item_from_jacket
    AFTER DELETE ON space_items
    FOR EACH ROW
    EXECUTE FUNCTION unsync_space_item_from_jacket();

-- ============================================================================
-- TRIGGER: Clean up on genus DELETE
-- Removes from both space jacket and profile jacket.
-- Cascades deletion to space_items.
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_genus_from_jackets()
RETURNS TRIGGER AS $$
DECLARE
    profile_jacket_id TEXT;
    space_jacket_id TEXT;
BEGIN
    -- Skip if this IS a jacket netdoc
    IF EXISTS (SELECT 1 FROM netdoc WHERE id = OLD.id AND is_jacket = TRUE) THEN
        RETURN OLD;
    END IF;

    -- Remove from parent space's jacket
    IF OLD.space_id IS NOT NULL THEN
        space_jacket_id := get_space_jacket_id(OLD.space_id);
        IF space_jacket_id IS NOT NULL THEN
            PERFORM remove_link_from_jacket(OLD.id, space_jacket_id);
        END IF;
    END IF;

    -- Remove from creator's profile jacket
    IF OLD.creator_id IS NOT NULL THEN
        profile_jacket_id := get_profile_jacket_id(OLD.creator_id);
        IF profile_jacket_id IS NOT NULL THEN
            PERFORM remove_link_from_jacket(OLD.id, profile_jacket_id);
        END IF;
    END IF;

    -- Cascade to space_items (fires unsync_space_item_from_jacket for each)
    DELETE FROM space_items WHERE genus_id = OLD.id;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_cleanup_genus_from_jackets ON genus;
CREATE TRIGGER trigger_cleanup_genus_from_jackets
    BEFORE DELETE ON genus
    FOR EACH ROW
    EXECUTE FUNCTION cleanup_genus_from_jackets();

-- ============================================================================
-- FUNCTION: get_missing_jacket_links(jacket_id, proposed_content)
-- Shared logic for finding missing required links in jacket content.
-- Called by the server for validation and by the trigger for auto-append.
--
-- Required links depend on space type:
--   Profile: /netdoc/ID for all user-created netdocs (minus gallery),
--            /chat/ID for all user-created standalone chats
--   Collection: /netdoc/ID or /chat/ID for all space_items
--   Regular: /netdoc/ID for all netdocs parented here,
--            /chat/ID for all standalone chats parented here
-- ============================================================================

CREATE OR REPLACE FUNCTION get_missing_jacket_links(
    p_jacket_id TEXT,
    p_content TEXT
)
RETURNS TABLE(genus_id TEXT, link TEXT) AS $$
DECLARE
    space_rec RECORD;
    req RECORD;
    padded_content TEXT;
BEGIN
    SELECT s.id, s.monarch_id, s.is_profile, s.is_collection
    INTO space_rec
    FROM spaces s WHERE s.jacket = p_jacket_id;

    IF NOT FOUND THEN RETURN; END IF;

    -- Pad content with newlines for full-line matching
    padded_content := E'\n' || p_content || E'\n';

    IF space_rec.is_profile THEN
        FOR req IN
            SELECT g.id AS gid, '/netdoc/' || g.id AS lnk
            FROM genus g JOIN netdoc n ON n.id = g.id
            WHERE g.creator_id = space_rec.monarch_id
              AND n.is_jacket = FALSE
              AND g.id != p_jacket_id
              AND g.id != COALESCE((SELECT gallery FROM profile WHERE id = space_rec.monarch_id), '')
            UNION ALL
            SELECT g.id AS gid, '/chat/' || g.id AS lnk
            FROM genus g JOIN chat c ON c.id = g.id
            WHERE g.creator_id = space_rec.monarch_id
              AND c.is_standalone = TRUE
        LOOP
            IF strpos(padded_content COLLATE "C", E'\n' || req.lnk || E'\n') = 0 THEN
                genus_id := req.gid; link := req.lnk; RETURN NEXT;
            END IF;
        END LOOP;

    ELSIF space_rec.is_collection THEN
        FOR req IN
            SELECT si.genus_id AS gid,
                   CASE WHEN EXISTS (SELECT 1 FROM netdoc WHERE id = si.genus_id)
                        THEN '/netdoc/' || si.genus_id
                        ELSE '/chat/' || si.genus_id
                   END AS lnk
            FROM space_items si
            WHERE si.space_id = space_rec.id AND si.genus_id != p_jacket_id
        LOOP
            IF strpos(padded_content COLLATE "C", E'\n' || req.lnk || E'\n') = 0 THEN
                genus_id := req.gid; link := req.lnk; RETURN NEXT;
            END IF;
        END LOOP;

    ELSE
        FOR req IN
            SELECT g.id AS gid, '/netdoc/' || g.id AS lnk
            FROM genus g JOIN netdoc n ON n.id = g.id
            WHERE g.space_id = space_rec.id
              AND n.is_jacket = FALSE
              AND g.id != COALESCE((SELECT gallery FROM profile WHERE id = g.creator_id), '')
            UNION ALL
            SELECT g.id AS gid, '/chat/' || g.id AS lnk
            FROM genus g JOIN chat c ON c.id = g.id
            WHERE g.space_id = space_rec.id AND c.is_standalone = TRUE
        LOOP
            IF strpos(padded_content COLLATE "C", E'\n' || req.lnk || E'\n') = 0 THEN
                genus_id := req.gid; link := req.lnk; RETURN NEXT;
            END IF;
        END LOOP;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- TRIGGER: Enforce required links in jacket content on UPDATE
-- Calls get_missing_jacket_links and re-appends any missing links.
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_jacket_links()
RETURNS TRIGGER AS $$
DECLARE
    missing_links TEXT := '';
    req RECORD;
BEGIN
    IF NOT NEW.is_jacket THEN RETURN NEW; END IF;

    FOR req IN SELECT link FROM get_missing_jacket_links(NEW.id, NEW.content) LOOP
        missing_links := missing_links || E'\n' || req.link;
    END LOOP;

    IF missing_links != '' THEN
        IF NEW.content = '' THEN
            NEW.content := ltrim(missing_links, E'\n');
        ELSE
            NEW.content := NEW.content || missing_links;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_enforce_jacket_links ON netdoc;
CREATE TRIGGER trigger_enforce_jacket_links
    BEFORE UPDATE OF content ON netdoc
    FOR EACH ROW
    EXECUTE FUNCTION enforce_jacket_links();

-- ============================================================================
-- DATA FIXUP: ensure existing jackets comply with current constraints
-- ============================================================================

-- Parent all existing jackets to their spaces (jackets no longer float)
UPDATE genus g
SET space_id = s.id
FROM spaces s
WHERE s.jacket = g.id
  AND g.space_id IS NULL;

-- Set comment mode to whitelist (no entries = no access) on non-profile jackets
UPDATE genus
SET perms_mode_comment = 'whitelist'
WHERE id IN (
    SELECT s.jacket FROM spaces s
    WHERE s.jacket IS NOT NULL
      AND s.is_profile = FALSE
);

-- Remove any existing comment permissions on non-profile jackets
DELETE FROM genus_permission
WHERE permission_type = 'comment'
  AND genus_id IN (
    SELECT s.jacket FROM spaces s
    WHERE s.jacket IS NOT NULL
      AND s.is_profile = FALSE
);

-- Remove any existing companion chats on non-profile jackets
DELETE FROM chat
WHERE id IN (
    SELECT s.jacket FROM spaces s
    JOIN netdoc n ON n.id = s.jacket
    WHERE s.jacket IS NOT NULL
      AND s.is_profile = FALSE
      AND n.is_jacket = TRUE
);