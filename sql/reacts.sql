-- ============================================================================
-- MESSAGE REACTIONS (IRCv3 +draft/react)
-- One reaction per user per message via UNIQUE constraint
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_reactions (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
    reaction VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_user ON message_reactions(user_id);

CREATE OR REPLACE FUNCTION check_reaction_permission()
RETURNS TRIGGER AS $$
DECLARE
  v_chat_id TEXT;
  v_creator_id UUID;
  v_space_id TEXT;
  v_space_role TEXT;
  v_mode TEXT;
  v_has_permission BOOLEAN := FALSE;
BEGIN
  SELECT cm.chat_id INTO v_chat_id
  FROM chat_message cm
  WHERE cm.id = NEW.message_id;

  IF v_chat_id IS NULL THEN
    RAISE EXCEPTION 'Message not found';
  END IF;

  SELECT creator_id, space_id INTO v_creator_id, v_space_id
  FROM genus WHERE id = v_chat_id;

  IF NEW.user_id = v_creator_id THEN
    v_has_permission := TRUE;
  END IF;

  IF NOT v_has_permission AND v_space_id IS NOT NULL THEN
    SELECT role INTO v_space_role
    FROM space_members
    WHERE space_id = v_space_id AND user_id = NEW.user_id;

    IF v_space_role IN ('monarch', 'custodian') THEN
      v_has_permission := TRUE;
    END IF;
  END IF;

  IF NOT v_has_permission THEN
    SELECT perms_mode_comment INTO v_mode FROM genus WHERE id = v_chat_id;

    IF v_mode = 'blacklist' THEN
      v_has_permission := NOT EXISTS (
        SELECT 1 FROM genus_permission
        WHERE genus_id = v_chat_id
          AND permission_type = 'comment'
          AND user_id = NEW.user_id
          AND is_blacklist = TRUE
      );
    ELSE
      v_has_permission := EXISTS (
        SELECT 1 FROM genus_permission
        WHERE genus_id = v_chat_id
          AND permission_type = 'comment'
          AND user_id = NEW.user_id
          AND is_blacklist = FALSE
      );
    END IF;
  END IF;

  IF NOT v_has_permission THEN
    RAISE EXCEPTION 'User does not have comment permission on this chat';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_reaction_permission
  BEFORE INSERT ON message_reactions
  FOR EACH ROW
  EXECUTE FUNCTION check_reaction_permission();
