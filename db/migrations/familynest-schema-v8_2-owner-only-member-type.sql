-- ============================================================
-- FamilyNest v8.2 — set_member_type becomes OWNER-only
--
-- Originally any adult could reclassify any member adult/child, which
-- let one adult demote another adult to child (and a child can't self-
-- pause or self-leave). Tighten it to owner-only, matching set_member_role
-- — owners are the family admins. The app hides the adult/child button for
-- non-owners too, but this is the server-side enforcement.
--
-- Safe to run on live in the SQL Editor; idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION set_member_type(p_member_id uuid, p_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_nest_id uuid;
  v_cur_role text;
  v_is_owner boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_type NOT IN ('adult', 'child') THEN
    RAISE EXCEPTION 'invalid_type';
  END IF;

  SELECT nest_id, role INTO v_nest_id, v_cur_role
    FROM nest_members WHERE id = p_member_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM nest_members
     WHERE nest_id = v_nest_id AND user_id = v_uid AND role = 'owner'
  ) INTO v_is_owner;
  IF NOT v_is_owner THEN
    RAISE EXCEPTION 'not_owner';
  END IF;

  IF v_cur_role = 'owner' AND p_type = 'child' THEN
    RAISE EXCEPTION 'owner_must_be_adult';
  END IF;

  PERFORM set_config('familynest.priv', 'on', true);
  UPDATE nest_members SET member_type = p_type WHERE id = p_member_id;
  PERFORM set_config('familynest.priv', 'off', true);
END;
$$;
REVOKE ALL ON FUNCTION set_member_type(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_member_type(uuid, text) TO authenticated;

-- ── DONE ──────────────────────────────────────────────────
