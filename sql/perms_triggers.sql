-- ============================================================================
-- PERMISSIONS: trigger bindings
--
-- Two layers: genus permissions and space permissions.
-- Same cascade chain: write > comment > read
--
-- Trigger ordering matters:
--   BEFORE triggers: mode cascade, owner protection, ceiling enforcement
--   AFTER triggers: grant cascade, revoke cascade, freeze/thaw
-- ============================================================================

-- ============================================================================
-- GENUS PERMISSION TRIGGERS
-- ============================================================================

-- Mode cascade (BEFORE UPDATE)
DROP TRIGGER IF EXISTS trigger_cascade_genus_perms_mode ON genus;
CREATE TRIGGER trigger_cascade_genus_perms_mode
    BEFORE UPDATE ON genus
    FOR EACH ROW
    EXECUTE FUNCTION cascade_genus_perms_mode();

-- Block comment permissions on non-profile jacket genus rows (BEFORE INSERT)
DROP TRIGGER IF EXISTS trigger_block_comment_nonprofile_jacket ON genus_permission;
CREATE TRIGGER trigger_block_comment_nonprofile_jacket
    BEFORE INSERT ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION block_comment_on_nonprofile_jacket();

-- Block write permissions on galleries (BEFORE INSERT)
DROP TRIGGER IF EXISTS trigger_block_gallery_write_perms ON genus_permission;
CREATE TRIGGER trigger_block_gallery_write_perms
    BEFORE INSERT ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION block_gallery_write_perms();

-- Ceiling enforcement (BEFORE INSERT — reject grants exceeding space ceiling)
DROP TRIGGER IF EXISTS trigger_enforce_genus_perm_ceiling ON genus_permission;
CREATE TRIGGER trigger_enforce_genus_perm_ceiling
    BEFORE INSERT ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION enforce_genus_perm_ceiling();

-- Owner/custodian protection (BEFORE DELETE — prevent deletion of protected perms)
DROP TRIGGER IF EXISTS trigger_protect_genus_owner_perm ON genus_permission;
CREATE TRIGGER trigger_protect_genus_owner_perm
    BEFORE DELETE ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION protect_genus_owner_perm();

-- Grant cascade (AFTER INSERT — write→comment+read, comment→read)
DROP TRIGGER IF EXISTS trigger_cascade_genus_perm_grant ON genus_permission;
CREATE TRIGGER trigger_cascade_genus_perm_grant
    AFTER INSERT ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION cascade_genus_perm_grant();

-- Revoke cascade (AFTER DELETE — read→comment+write, comment→write)
DROP TRIGGER IF EXISTS trigger_cascade_genus_perm_revoke ON genus_permission;
CREATE TRIGGER trigger_cascade_genus_perm_revoke
    AFTER DELETE ON genus_permission
    FOR EACH ROW
    EXECUTE FUNCTION cascade_genus_perm_revoke();

-- ============================================================================
-- SPACE PERMISSION TRIGGERS
-- ============================================================================

-- Mode cascade (BEFORE UPDATE)
DROP TRIGGER IF EXISTS trigger_cascade_space_perms_mode ON spaces;
CREATE TRIGGER trigger_cascade_space_perms_mode
    BEFORE UPDATE ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION cascade_space_perms_mode();

-- Owner/custodian protection (BEFORE DELETE)
DROP TRIGGER IF EXISTS trigger_protect_space_owner_perm ON space_permission;
CREATE TRIGGER trigger_protect_space_owner_perm
    BEFORE DELETE ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION protect_space_owner_perm();

-- Grant cascade (AFTER INSERT — write→comment+read, comment→read)
DROP TRIGGER IF EXISTS trigger_cascade_space_perm_grant ON space_permission;
CREATE TRIGGER trigger_cascade_space_perm_grant
    AFTER INSERT ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION cascade_space_perm_grant();

-- Revoke cascade (AFTER DELETE — read→comment+write, comment→write)
DROP TRIGGER IF EXISTS trigger_cascade_space_perm_revoke ON space_permission;
CREATE TRIGGER trigger_cascade_space_perm_revoke
    AFTER DELETE ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION cascade_space_perm_revoke();

-- ============================================================================
-- FREEZE / THAW TRIGGERS
-- ============================================================================

-- Mass freeze/thaw on space mode change (AFTER UPDATE on spaces)
DROP TRIGGER IF EXISTS trigger_freeze_thaw_space_mode ON spaces;
CREATE TRIGGER trigger_freeze_thaw_space_mode
    AFTER UPDATE OF perms_mode_read, perms_mode_comment, perms_mode_write ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION freeze_thaw_on_space_mode_change();

-- Per-user thaw when whitelist entry added (AFTER INSERT on space_permission)
DROP TRIGGER IF EXISTS trigger_thaw_on_space_perm_grant ON space_permission;
CREATE TRIGGER trigger_thaw_on_space_perm_grant
    AFTER INSERT ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION thaw_on_space_perm_grant();

-- Per-user freeze when whitelist entry removed (AFTER DELETE on space_permission)
DROP TRIGGER IF EXISTS trigger_freeze_on_space_perm_revoke ON space_permission;
CREATE TRIGGER trigger_freeze_on_space_perm_revoke
    AFTER DELETE ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION freeze_on_space_perm_revoke();

-- Freeze when blacklist entry added (AFTER INSERT on space_permission)
DROP TRIGGER IF EXISTS trigger_freeze_on_space_blacklist_add ON space_permission;
CREATE TRIGGER trigger_freeze_on_space_blacklist_add
    AFTER INSERT ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION freeze_on_space_blacklist_add();

-- Thaw when blacklist entry removed (AFTER DELETE on space_permission)
DROP TRIGGER IF EXISTS trigger_thaw_on_space_blacklist_remove ON space_permission;
CREATE TRIGGER trigger_thaw_on_space_blacklist_remove
    AFTER DELETE ON space_permission
    FOR EACH ROW
    EXECUTE FUNCTION thaw_on_space_blacklist_remove();

-- ============================================================================
-- SPACE MANAGEMENT TRIGGERS
-- ============================================================================

-- Custodian limit (BEFORE INSERT/UPDATE on space_members)
DROP TRIGGER IF EXISTS trigger_enforce_custodian_limit ON space_members;
CREATE TRIGGER trigger_enforce_custodian_limit
    BEFORE INSERT OR UPDATE OF role ON space_members
    FOR EACH ROW
    EXECUTE FUNCTION enforce_custodian_limit();

-- Reparent genera on space deletion (BEFORE DELETE on spaces)
DROP TRIGGER IF EXISTS trigger_reparent_genera_on_space_delete ON spaces;
CREATE TRIGGER trigger_reparent_genera_on_space_delete
    BEFORE DELETE ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION reparent_genera_on_space_delete();

-- Mark deleted creator (BEFORE UPDATE on spaces — when monarch_id set to NULL)
DROP TRIGGER IF EXISTS trigger_mark_deleted_creator ON spaces;
CREATE TRIGGER trigger_mark_deleted_creator
    BEFORE UPDATE OF monarch_id ON spaces
    FOR EACH ROW
    EXECUTE FUNCTION mark_deleted_creator();