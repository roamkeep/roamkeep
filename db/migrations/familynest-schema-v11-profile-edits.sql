-- v11 — editable profiles + family name
--
-- Runs against an EXISTING live database. Idempotent and non-destructive;
-- safe to re-run. Adds two SECURITY DEFINER RPCs so a family can change
-- what was previously write-once at create/join:
--
--   * rename_keep(keep_id, name)            — owner renames the family.
--   * update_member_profile(id, name, avatar) — a member edits their own
--     display name + avatar, OR an owner edits any member's.
--
-- Why RPCs and not a plain client UPDATE:
--   - keeps has NO update RLS policy, so a client can't rename it directly.
--   - Editing ANOTHER member's row is cross-row; the "update own row" RLS
--     policy forbids it. A DEFINER function is the only owner path.
-- name/avatar are NOT guard-protected columns (the guard trigger only
-- covers role/member_type/paused_until), so no roamkeep.priv flag dance.
--
-- Length rules mirror create_keep and the keeps_name_len / nm_name_len /
-- nm_avatar_len CHECK constraints (40 / 40 / 8).
--
-- Grants follow the v10 hardening: REVOKE from PUBLIC *and* anon by name
-- (Supabase's default privileges grant anon EXECUTE on every new public
-- function), GRANT to authenticated only. db/tests/v10-verify.sql selects
-- the RPC surface by return type, so it covers both of these automatically.
--
-- Client bump: app 4.6.0 (both RPCs are new call sites).

begin;

-- rename_keep: owner-only family rename.
CREATE OR REPLACE FUNCTION rename_keep(p_keep_id uuid, p_name text)
RETURNS TABLE (keep_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_family_name';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM keep_members
     WHERE keep_id = p_keep_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  UPDATE keeps SET name = trim(p_name) WHERE id = p_keep_id;
  RETURN QUERY SELECT trim(p_name);
END;
$$;
REVOKE ALL ON FUNCTION rename_keep(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION rename_keep(uuid, text) TO authenticated;

-- update_member_profile: self OR owner-of-keep edits name + avatar.
CREATE OR REPLACE FUNCTION update_member_profile(
  p_member_id uuid,
  p_name text,
  p_avatar text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_keep_id uuid;
  v_target_uid uuid;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF length(trim(coalesce(p_name, ''))) = 0 OR length(p_name) > 40 THEN
    RAISE EXCEPTION 'invalid_display_name';
  END IF;
  IF length(coalesce(p_avatar, '')) < 1 OR length(p_avatar) > 8 THEN
    RAISE EXCEPTION 'invalid_avatar';
  END IF;

  SELECT keep_id, user_id INTO v_keep_id, v_target_uid
    FROM keep_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  IF v_target_uid <> v_uid THEN
    SELECT EXISTS (
      SELECT 1 FROM keep_members
       WHERE keep_id = v_keep_id AND user_id = v_uid AND role = 'owner'
    ) INTO v_is_owner;
    IF NOT v_is_owner THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  END IF;

  UPDATE keep_members
     SET name = trim(p_name), avatar = p_avatar
   WHERE id = p_member_id;
END;
$$;
REVOKE ALL ON FUNCTION update_member_profile(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION update_member_profile(uuid, text, text) TO authenticated;

commit;
