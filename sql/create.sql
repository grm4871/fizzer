-- ============================================================================
-- ATOMIC CREATE FUNCTIONS: Chat and Netdoc creation with all required setup
-- ============================================================================

-- ============================================================================
-- CREATE CHAT: Atomic chat creation with all required setup
-- Returns the new chat ID
-- ============================================================================
CREATE OR REPLACE FUNCTION create_chat(
    p_name TEXT,
    p_creator_id UUID,
    p_space_id TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    v_new_id TEXT;
    v_target_space_id TEXT;
    v_max_order_key INT;
BEGIN
    -- 1. Generate ID and create genus + netdoc (trigger creates companion chat)
    v_new_id := find_earliest_genus_id();

    INSERT INTO genus (id, name, creator_id, space_id)
    VALUES (v_new_id, p_name, p_creator_id, p_space_id);

    INSERT INTO netdoc (id, content) VALUES (v_new_id, '');

    -- 2. Mark chat as standalone
    UPDATE chat SET is_standalone = TRUE WHERE id = v_new_id;

    -- 3. Grant comment permission (cascade trigger auto-grants read)
    INSERT INTO genus_permission (genus_id, permission_type, user_id)
    VALUES (v_new_id, 'comment', p_creator_id)
    ON CONFLICT DO NOTHING;

    -- 4. Add to space (profile space if not specified)
    v_target_space_id := COALESCE(
        p_space_id,
        (SELECT id FROM spaces WHERE monarch_id = p_creator_id AND is_profile = TRUE LIMIT 1)
    );

    IF v_target_space_id IS NOT NULL THEN
        SELECT COALESCE(MAX(order_key), -1) + 1 INTO v_max_order_key
        FROM space_items WHERE space_id = v_target_space_id;

        INSERT INTO space_items (space_id, genus_id, order_key)
        VALUES (v_target_space_id, v_new_id, v_max_order_key);
    END IF;

    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- CREATE NETDOC: Atomic netdoc creation with all required setup
-- Returns the new netdoc ID
-- ============================================================================
CREATE OR REPLACE FUNCTION create_netdoc(
    p_name TEXT,
    p_creator_id UUID,
    p_content TEXT DEFAULT '',
    p_is_dm BOOLEAN DEFAULT FALSE,
    p_is_unlisted BOOLEAN DEFAULT FALSE,
    p_space_id TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    v_new_id TEXT;
    v_target_space_id TEXT;
    v_max_order_key INT;
BEGIN
    -- 1. Generate ID and create genus + netdoc
    v_new_id := find_earliest_genus_id();

    INSERT INTO genus (id, name, creator_id, space_id, is_unlisted)
    VALUES (v_new_id, p_name, p_creator_id, p_space_id, p_is_unlisted);

    INSERT INTO netdoc (id, content) VALUES (v_new_id, p_content);

    -- 2. Set DM mode if needed (cascade trigger sets comment+write to whitelist)
    IF p_is_dm THEN
        UPDATE genus SET perms_mode_read = 'whitelist' WHERE id = v_new_id;
    END IF;

    -- 3. Add to space (profile space if not specified, skip for DMs)
    IF NOT p_is_dm THEN
        v_target_space_id := COALESCE(
            p_space_id,
            (SELECT id FROM spaces WHERE monarch_id = p_creator_id AND is_profile = TRUE LIMIT 1)
        );

        IF v_target_space_id IS NOT NULL THEN
            SELECT COALESCE(MAX(order_key), -1) + 1 INTO v_max_order_key
            FROM space_items WHERE space_id = v_target_space_id;

            INSERT INTO space_items (space_id, genus_id, order_key)
            VALUES (v_target_space_id, v_new_id, v_max_order_key);
        END IF;

        -- 4. Enable notifications for creator
        INSERT INTO genus_notifications (user_id, genus_id)
        VALUES (p_creator_id, v_new_id)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN v_new_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: create_profile
-- Atomic profile creation. Disables triggers and calls helpers directly
-- to avoid cascade chains. Jacket helpers come from jacket.sql.
--
-- Must load after init.sql and jacket.sql.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_profile(
    p_username TEXT,
    p_display_name TEXT,
    p_password TEXT,
    p_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    new_user_id UUID;
    profile_space_id TEXT;
    saved_space_id TEXT;
BEGIN
    -- Disable all triggers to prevent cascade chains
    SET LOCAL session_replication_role = 'replica';

    IF p_id IS NOT NULL THEN
        INSERT INTO profile (id, username, display_name, password)
        VALUES (p_id, p_username, p_display_name, p_password)
        RETURNING id INTO new_user_id;
    ELSE
        INSERT INTO profile (username, display_name, password)
        VALUES (p_username, p_display_name, p_password)
        RETURNING id INTO new_user_id;
    END IF;

    -- Spaces
    profile_space_id := create_space_for_user(new_user_id, p_display_name, TRUE, FALSE);
    saved_space_id := create_space_for_user(new_user_id, p_display_name, FALSE, TRUE);

    -- Jackets (helper from jacket.sql)
    PERFORM create_jacket_for_space(profile_space_id, new_user_id, TRUE);
    PERFORM create_jacket_for_space(saved_space_id, new_user_id, FALSE);

    -- Gallery
    PERFORM create_gallery_for_user(new_user_id, p_username, profile_space_id);

    -- Re-enable triggers
    SET LOCAL session_replication_role = 'origin';

    RETURN new_user_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: create_space
-- Atomic space creation. Creates space + jacket + monarch membership.
-- Disables triggers to call helpers directly.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_space(
    p_name TEXT,
    p_monarch_id UUID,
    p_description TEXT DEFAULT '',
    p_id TEXT DEFAULT NULL
) RETURNS TEXT AS $$
DECLARE
    new_space_id TEXT;
BEGIN
    SET LOCAL session_replication_role = 'replica';

    new_space_id := COALESCE(p_id, find_earliest_space_id());

    INSERT INTO spaces (id, monarch_id, name, description,
                        perms_mode_read, perms_mode_comment, perms_mode_write)
    VALUES (new_space_id, p_monarch_id, p_name, p_description,
            'blacklist', 'blacklist', 'whitelist');

    INSERT INTO space_members (space_id, user_id, role)
    VALUES (new_space_id, p_monarch_id, 'monarch');

    PERFORM create_jacket_for_space(new_space_id, p_monarch_id, FALSE);

    SET LOCAL session_replication_role = 'origin';

    RETURN new_space_id;
END;
$$ LANGUAGE plpgsql;