-- ============================================================================
-- PERMISSIONS: enum + trigger functions
--
-- Two layers: space permissions (ceiling) and genus permissions (per-doc).
-- Same cascade chain at both layers:
--   write (netdoc) > comment (chat) > read (both)
--
-- Space permissions act as a CEILING for genus permissions.
-- Profile spaces are exempt: genus perms can override upward.
-- Collection spaces are always private to owner — no perms needed.
--
-- Freeze/thaw: when space restricts access, genus perms for affected users
-- move to genus_permission_frozen. When access is restored, they move back.
-- ============================================================================

DO $$ BEGIN
    CREATE TYPE perms_mode AS ENUM ('whitelist', 'blacklist');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- HELPERS
-- ============================================================================

-- Check if a user has space-level access for a given perm type.
-- Owner and custodians always have access.

CREATE OR REPLACE FUNCTION user_has_space_access(
    p_space_id TEXT, p_user_id UUID, p_perm_type TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    mode perms_mode;
BEGIN
    IF EXISTS (SELECT 1 FROM spaces WHERE id = p_space_id AND monarch_id = p_user_id) THEN
        RETURN TRUE;
    END IF;
    IF EXISTS (
        SELECT 1 FROM space_members
        WHERE space_id = p_space_id AND user_id = p_user_id AND role = 'custodian'
    ) THEN
        RETURN TRUE;
    END IF;

    IF p_perm_type = 'read' THEN
        SELECT perms_mode_read INTO mode FROM spaces WHERE id = p_space_id;
    ELSIF p_perm_type = 'comment' THEN
        SELECT perms_mode_comment INTO mode FROM spaces WHERE id = p_space_id;
    ELSIF p_perm_type = 'write' THEN
        SELECT perms_mode_write INTO mode FROM spaces WHERE id = p_space_id;
    ELSE
        RETURN FALSE;
    END IF;

    IF mode = 'blacklist' THEN
        RETURN NOT EXISTS (
            SELECT 1 FROM space_permission
            WHERE space_id = p_space_id AND permission_type = p_perm_type
              AND user_id = p_user_id AND is_blacklist = TRUE
        );
    ELSE
        RETURN EXISTS (
            SELECT 1 FROM space_permission
            WHERE space_id = p_space_id AND permission_type = p_perm_type
              AND user_id = p_user_id AND is_blacklist = FALSE
        );
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Shared mode cascade logic. Returns ARRAY[new_read, new_comment, new_write].
-- Grant cascades down, revoke cascades up:
--   write→blacklist: also comment→blacklist, read→blacklist
--   comment→blacklist: also read→blacklist
--   read→whitelist: also comment→whitelist, write→whitelist
--   comment→whitelist: also write→whitelist

CREATE OR REPLACE FUNCTION apply_perms_mode_cascade(
    old_r perms_mode, old_c perms_mode, old_w perms_mode,
    new_r perms_mode, new_c perms_mode, new_w perms_mode
) RETURNS perms_mode[] AS $$
BEGIN
    IF new_w = 'blacklist' AND old_w != 'blacklist' THEN
        new_c := 'blacklist'; new_r := 'blacklist';
    END IF;
    IF new_c = 'blacklist' AND old_c != 'blacklist' THEN
        new_r := 'blacklist';
    END IF;
    IF new_r = 'whitelist' AND old_r != 'whitelist' THEN
        new_c := 'whitelist'; new_w := 'whitelist';
    END IF;
    IF new_c = 'whitelist' AND old_c != 'whitelist' THEN
        new_w := 'whitelist';
    END IF;
    RETURN ARRAY[new_r, new_c, new_w];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Freeze genus perms for a user at a specific perm level in a space.
-- Copies from genus_permission → genus_permission_frozen, then deletes.
-- Skips genus creators (they always retain perms on their own docs).

CREATE OR REPLACE FUNCTION freeze_user_genus_perms(
    p_space_id TEXT, p_user_id UUID, p_perm_type TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO genus_permission_frozen
        (genus_id, permission_type, user_id, is_blacklist, frozen_by_space_id, created_at)
    SELECT gp.genus_id, gp.permission_type, gp.user_id, gp.is_blacklist, p_space_id, gp.created_at
    FROM genus_permission gp
    JOIN genus g ON g.id = gp.genus_id
    WHERE g.space_id = p_space_id
      AND gp.permission_type = p_perm_type
      AND gp.user_id = p_user_id
      AND NOT gp.is_blacklist
      AND gp.user_id != COALESCE(g.creator_id, '00000000-0000-0000-0000-000000000000'::UUID)
    ON CONFLICT DO NOTHING;

    DELETE FROM genus_permission gp
    USING genus g
    WHERE g.id = gp.genus_id
      AND g.space_id = p_space_id
      AND gp.permission_type = p_perm_type
      AND gp.user_id = p_user_id
      AND NOT gp.is_blacklist
      AND gp.user_id != COALESCE(g.creator_id, '00000000-0000-0000-0000-000000000000'::UUID);
END;
$$ LANGUAGE plpgsql;

-- Thaw frozen genus perms for a user at a specific perm level.
-- Copies from genus_permission_frozen → genus_permission, then deletes.

CREATE OR REPLACE FUNCTION thaw_user_genus_perms(
    p_space_id TEXT, p_user_id UUID, p_perm_type TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO genus_permission
        (genus_id, permission_type, user_id, is_blacklist, created_at)
    SELECT gpf.genus_id, gpf.permission_type, gpf.user_id, gpf.is_blacklist, gpf.created_at
    FROM genus_permission_frozen gpf
    WHERE gpf.frozen_by_space_id = p_space_id
      AND gpf.user_id = p_user_id
      AND gpf.permission_type = p_perm_type
    ON CONFLICT DO NOTHING;

    DELETE FROM genus_permission_frozen
    WHERE frozen_by_space_id = p_space_id
      AND user_id = p_user_id
      AND permission_type = p_perm_type;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 1: GENUS PERMISSION FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION cascade_genus_perms_mode()
RETURNS TRIGGER AS $$
DECLARE
    result perms_mode[];
BEGIN
    -- Non-profile jackets: comment mode must stay whitelist
    IF NEW.perms_mode_comment != 'whitelist' AND EXISTS (
        SELECT 1 FROM netdoc n
        JOIN spaces s ON s.jacket = n.id
        WHERE n.id = NEW.id AND n.is_jacket = TRUE AND s.is_profile = FALSE
    ) THEN
        NEW.perms_mode_comment := 'whitelist';
    END IF;

    result := apply_perms_mode_cascade(
        OLD.perms_mode_read, OLD.perms_mode_comment, OLD.perms_mode_write,
        NEW.perms_mode_read, NEW.perms_mode_comment, NEW.perms_mode_write
    );
    NEW.perms_mode_read := result[1];
    NEW.perms_mode_comment := result[2];
    NEW.perms_mode_write := result[3];
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cascade_genus_perm_grant()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.permission_type = 'write' THEN
        INSERT INTO genus_permission (genus_id, permission_type, user_id, is_blacklist)
        VALUES (NEW.genus_id, 'comment', NEW.user_id, NEW.is_blacklist)
        ON CONFLICT DO NOTHING;
        INSERT INTO genus_permission (genus_id, permission_type, user_id, is_blacklist)
        VALUES (NEW.genus_id, 'read', NEW.user_id, NEW.is_blacklist)
        ON CONFLICT DO NOTHING;
    ELSIF NEW.permission_type = 'comment' THEN
        INSERT INTO genus_permission (genus_id, permission_type, user_id, is_blacklist)
        VALUES (NEW.genus_id, 'read', NEW.user_id, NEW.is_blacklist)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cascade_genus_perm_revoke()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.permission_type = 'read' THEN
        DELETE FROM genus_permission
        WHERE genus_id = OLD.genus_id AND permission_type = 'comment'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
        DELETE FROM genus_permission
        WHERE genus_id = OLD.genus_id AND permission_type = 'write'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
    ELSIF OLD.permission_type = 'comment' THEN
        DELETE FROM genus_permission
        WHERE genus_id = OLD.genus_id AND permission_type = 'write'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Owner cannot lose read or write. Owner CAN lose comment.
-- Custodians of parent space are also protected.

CREATE OR REPLACE FUNCTION protect_genus_owner_perm()
RETURNS TRIGGER AS $$
DECLARE
    monarch_id UUID;
BEGIN
    IF OLD.permission_type NOT IN ('read', 'write') OR OLD.user_id IS NULL THEN
        RETURN OLD;
    END IF;

    SELECT creator_id INTO monarch_id FROM genus WHERE id = OLD.genus_id;
    IF OLD.user_id = monarch_id THEN RETURN NULL; END IF;

    IF EXISTS (
        SELECT 1 FROM genus g
        JOIN space_members sm ON sm.space_id = g.space_id
        WHERE g.id = OLD.genus_id AND sm.user_id = OLD.user_id AND sm.role = 'custodian'
    ) THEN
        RETURN NULL;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Block comment permissions on non-profile jacket genus rows.
-- Non-profile jackets have no chat — comment perms are meaningless.

CREATE OR REPLACE FUNCTION block_comment_on_nonprofile_jacket()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.permission_type = 'comment' AND EXISTS (
        SELECT 1 FROM netdoc n
        JOIN spaces s ON s.jacket = n.id
        WHERE n.id = NEW.genus_id AND n.is_jacket = TRUE AND s.is_profile = FALSE
    ) THEN
        RETURN NULL;  -- silently skip, don't raise
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Block write permissions on galleries (profile homepages)
-- Galleries should only be editable by their owner
CREATE OR REPLACE FUNCTION block_gallery_write_perms()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.permission_type = 'write' AND EXISTS (
        SELECT 1 FROM profile WHERE gallery = NEW.genus_id
    ) THEN
        RAISE EXCEPTION 'Cannot grant write permissions to a gallery netdoc';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 2: SPACE PERMISSION FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION cascade_space_perms_mode()
RETURNS TRIGGER AS $$
DECLARE
    result perms_mode[];
BEGIN
    -- Profile spaces: write must stay whitelist
    IF NEW.is_profile AND NEW.perms_mode_write = 'blacklist' THEN
        NEW.perms_mode_write := 'whitelist';
    END IF;

    -- Collection spaces: comment must stay whitelist (no commenting allowed)
    IF NEW.is_collection AND NEW.perms_mode_comment != 'whitelist' THEN
        RAISE EXCEPTION 'Collection spaces cannot have commenting enabled';
    END IF;

    result := apply_perms_mode_cascade(
        OLD.perms_mode_read, OLD.perms_mode_comment, OLD.perms_mode_write,
        NEW.perms_mode_read, NEW.perms_mode_comment, NEW.perms_mode_write
    );
    NEW.perms_mode_read := result[1];
    NEW.perms_mode_comment := result[2];
    NEW.perms_mode_write := result[3];
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cascade_space_perm_grant()
RETURNS TRIGGER AS $$
BEGIN
    -- Block comment permissions on collection spaces
    IF NEW.permission_type = 'comment' AND EXISTS (
        SELECT 1 FROM spaces WHERE id = NEW.space_id AND is_collection = TRUE
    ) THEN
        RAISE EXCEPTION 'Collection spaces cannot have comment permissions';
    END IF;

    IF NEW.permission_type = 'write' THEN
        -- Skip comment cascade for collection spaces
        IF NOT EXISTS (SELECT 1 FROM spaces WHERE id = NEW.space_id AND is_collection = TRUE) THEN
            INSERT INTO space_permission (space_id, permission_type, user_id, is_blacklist)
            VALUES (NEW.space_id, 'comment', NEW.user_id, NEW.is_blacklist)
            ON CONFLICT DO NOTHING;
        END IF;
        INSERT INTO space_permission (space_id, permission_type, user_id, is_blacklist)
        VALUES (NEW.space_id, 'read', NEW.user_id, NEW.is_blacklist)
        ON CONFLICT DO NOTHING;
    ELSIF NEW.permission_type = 'comment' THEN
        INSERT INTO space_permission (space_id, permission_type, user_id, is_blacklist)
        VALUES (NEW.space_id, 'read', NEW.user_id, NEW.is_blacklist)
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cascade_space_perm_revoke()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.permission_type = 'read' THEN
        DELETE FROM space_permission
        WHERE space_id = OLD.space_id AND permission_type = 'comment'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
        DELETE FROM space_permission
        WHERE space_id = OLD.space_id AND permission_type = 'write'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
    ELSIF OLD.permission_type = 'comment' THEN
        DELETE FROM space_permission
        WHERE space_id = OLD.space_id AND permission_type = 'write'
          AND user_id IS NOT DISTINCT FROM OLD.user_id AND is_blacklist = OLD.is_blacklist;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Owner cannot lose any space perms.
-- Custodians cannot lose read or write. CAN lose comment.

CREATE OR REPLACE FUNCTION protect_space_owner_perm()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.user_id IS NULL THEN RETURN OLD; END IF;

    -- Owner: block read/write removal
    IF EXISTS (SELECT 1 FROM spaces WHERE id = OLD.space_id AND monarch_id = OLD.user_id) THEN
        RETURN NULL;
    END IF;

    -- Custodian: block read/write removal
    IF EXISTS (
        SELECT 1 FROM space_members
        WHERE space_id = OLD.space_id AND user_id = OLD.user_id AND role = 'custodian'
    ) THEN
        RETURN NULL;
    END IF;

    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 3: CEILING ENFORCEMENT
-- Genus perms cannot exceed space perms (profile spaces exempt).
-- Genus creators always retain perms on their own docs.
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_genus_perm_ceiling()
RETURNS TRIGGER AS $$
DECLARE
    parent_space_id TEXT;
    genus_creator_id UUID;
BEGIN
    IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

    SELECT space_id, creator_id INTO parent_space_id, genus_creator_id
    FROM genus WHERE id = NEW.genus_id;

    IF parent_space_id IS NULL THEN RETURN NEW; END IF;

    -- Profile spaces are NO LONGER exempt from ceiling constraint
    IF NEW.user_id = genus_creator_id THEN RETURN NEW; END IF;

    IF NOT NEW.is_blacklist THEN
        IF NOT user_has_space_access(parent_space_id, NEW.user_id, NEW.permission_type) THEN
            RAISE EXCEPTION 'Cannot grant genus % to user without space-level % access',
                NEW.permission_type, NEW.permission_type;
        END IF;
    END IF;

    IF NEW.is_blacklist AND NEW.permission_type = 'read' THEN
        IF user_has_space_access(parent_space_id, NEW.user_id, 'read') THEN
            RAISE EXCEPTION 'Cannot blacklist read at genus level when user has space-level read access';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 4: FREEZE / THAW
-- Uses freeze_user_genus_perms / thaw_user_genus_perms helpers.
-- ============================================================================

-- Mass freeze/thaw when space perms_mode changes.

CREATE OR REPLACE FUNCTION freeze_thaw_on_space_mode_change()
RETURNS TRIGGER AS $$
DECLARE
    perm_types TEXT[] := ARRAY['read', 'comment', 'write'];
    pt TEXT;
    old_mode perms_mode;
    new_mode perms_mode;
    affected_user UUID;
BEGIN
    IF NEW.is_profile OR NEW.is_collection THEN RETURN NEW; END IF;

    FOREACH pt IN ARRAY perm_types LOOP
        IF pt = 'read' THEN
            old_mode := OLD.perms_mode_read; new_mode := NEW.perms_mode_read;
        ELSIF pt = 'comment' THEN
            old_mode := OLD.perms_mode_comment; new_mode := NEW.perms_mode_comment;
        ELSE
            old_mode := OLD.perms_mode_write; new_mode := NEW.perms_mode_write;
        END IF;

        IF old_mode = new_mode THEN CONTINUE; END IF;

        IF old_mode = 'blacklist' AND new_mode = 'whitelist' THEN
            -- Going restrictive: freeze users who lack space access
            FOR affected_user IN
                SELECT DISTINCT gp.user_id
                FROM genus_permission gp
                JOIN genus g ON g.id = gp.genus_id
                WHERE g.space_id = NEW.id
                  AND gp.permission_type = pt
                  AND gp.user_id IS NOT NULL
                  AND NOT gp.is_blacklist
                  AND gp.user_id != COALESCE(g.creator_id, '00000000-0000-0000-0000-000000000000'::UUID)
                  AND NOT user_has_space_access(NEW.id, gp.user_id, pt)
            LOOP
                PERFORM freeze_user_genus_perms(NEW.id, affected_user, pt);
            END LOOP;

        ELSIF old_mode = 'whitelist' AND new_mode = 'blacklist' THEN
            -- Going permissive: thaw users who now have access
            FOR affected_user IN
                SELECT DISTINCT gpf.user_id
                FROM genus_permission_frozen gpf
                WHERE gpf.frozen_by_space_id = NEW.id
                  AND gpf.permission_type = pt
                  AND user_has_space_access(NEW.id, gpf.user_id, pt)
            LOOP
                PERFORM thaw_user_genus_perms(NEW.id, affected_user, pt);
            END LOOP;
            -- Clean up any remaining frozen at this level (users still without access)
            -- They stay frozen — no action needed.
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Per-user thaw: whitelist entry added → user gains access.

CREATE OR REPLACE FUNCTION thaw_on_space_perm_grant()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_blacklist OR NEW.user_id IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM spaces WHERE id = NEW.space_id AND (is_profile OR is_collection)) THEN
        RETURN NEW;
    END IF;
    PERFORM thaw_user_genus_perms(NEW.space_id, NEW.user_id, NEW.permission_type);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Per-user freeze: whitelist entry removed → user loses access.

CREATE OR REPLACE FUNCTION freeze_on_space_perm_revoke()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_blacklist OR OLD.user_id IS NULL THEN RETURN OLD; END IF;
    IF EXISTS (SELECT 1 FROM spaces WHERE id = OLD.space_id AND (is_profile OR is_collection)) THEN
        RETURN OLD;
    END IF;
    IF user_has_space_access(OLD.space_id, OLD.user_id, OLD.permission_type) THEN
        RETURN OLD;
    END IF;
    PERFORM freeze_user_genus_perms(OLD.space_id, OLD.user_id, OLD.permission_type);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Per-user freeze: blacklist entry added → user loses access (in blacklist mode).

CREATE OR REPLACE FUNCTION freeze_on_space_blacklist_add()
RETURNS TRIGGER AS $$
DECLARE
    mode perms_mode;
BEGIN
    IF NOT NEW.is_blacklist OR NEW.user_id IS NULL THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM spaces WHERE id = NEW.space_id AND (is_profile OR is_collection)) THEN
        RETURN NEW;
    END IF;

    IF NEW.permission_type = 'read' THEN
        SELECT perms_mode_read INTO mode FROM spaces WHERE id = NEW.space_id;
    ELSIF NEW.permission_type = 'comment' THEN
        SELECT perms_mode_comment INTO mode FROM spaces WHERE id = NEW.space_id;
    ELSE
        SELECT perms_mode_write INTO mode FROM spaces WHERE id = NEW.space_id;
    END IF;
    IF mode != 'blacklist' THEN RETURN NEW; END IF;

    PERFORM freeze_user_genus_perms(NEW.space_id, NEW.user_id, NEW.permission_type);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Per-user thaw: blacklist entry removed → user regains access (in blacklist mode).

CREATE OR REPLACE FUNCTION thaw_on_space_blacklist_remove()
RETURNS TRIGGER AS $$
DECLARE
    mode perms_mode;
BEGIN
    IF NOT OLD.is_blacklist OR OLD.user_id IS NULL THEN RETURN OLD; END IF;
    IF EXISTS (SELECT 1 FROM spaces WHERE id = OLD.space_id AND (is_profile OR is_collection)) THEN
        RETURN OLD;
    END IF;

    IF OLD.permission_type = 'read' THEN
        SELECT perms_mode_read INTO mode FROM spaces WHERE id = OLD.space_id;
    ELSIF OLD.permission_type = 'comment' THEN
        SELECT perms_mode_comment INTO mode FROM spaces WHERE id = OLD.space_id;
    ELSE
        SELECT perms_mode_write INTO mode FROM spaces WHERE id = OLD.space_id;
    END IF;
    IF mode != 'blacklist' THEN RETURN OLD; END IF;

    PERFORM thaw_user_genus_perms(OLD.space_id, OLD.user_id, OLD.permission_type);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- PART 5: SPACE MANAGEMENT
-- ============================================================================

CREATE OR REPLACE FUNCTION enforce_custodian_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role = 'custodian' THEN
        IF (SELECT COUNT(*) FROM space_members
            WHERE space_id = NEW.space_id AND role = 'custodian'
              AND id != COALESCE(NEW.id, -1)) >= 2 THEN
            RAISE EXCEPTION 'A space can have at most 2 custodians';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reparent_genera_on_space_delete()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE genus g SET space_id = (
        SELECT s.id FROM spaces s
        WHERE s.monarch_id = g.creator_id AND s.is_profile = TRUE LIMIT 1
    ) WHERE g.space_id = OLD.id;

    UPDATE genus SET space_id = NULL WHERE space_id = OLD.id;

    INSERT INTO genus_permission (genus_id, permission_type, user_id, is_blacklist, created_at)
    SELECT gpf.genus_id, gpf.permission_type, gpf.user_id, gpf.is_blacklist, gpf.created_at
    FROM genus_permission_frozen gpf WHERE gpf.frozen_by_space_id = OLD.id
    ON CONFLICT DO NOTHING;

    DELETE FROM genus_permission_frozen WHERE frozen_by_space_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mark_deleted_creator()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.monarch_id IS NOT NULL AND NEW.monarch_id IS NULL THEN
        NEW.deleted_creator := TRUE;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;