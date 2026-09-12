-- ============================================================
-- GEN Z — CHAT UPGRADES (run ONCE, additive + idempotent)
--  1) create_group_conversation — SECURITY DEFINER RPC so group
--     creation bypasses RLS (same fix as direct chats).
--  2) view-once media columns on messages.
-- ============================================================

-- ------------------------------------------------------------
-- 1) GROUP CREATION RPC
-- ------------------------------------------------------------
create or replace function public.create_group_conversation(p_name text, p_members uuid[])
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'not authenticated';
  end if;
  if p_name is null or trim(p_name) = '' then
    raise exception 'group name required';
  end if;
  if p_members is null or cardinality(p_members) = 0 then
    raise exception 'at least one member required';
  end if;

  insert into public.conversations (type, name, created_by)
  values ('group', trim(p_name), v_me)
  returning id into v_conv;

  insert into public.conversation_participants (conversation_id, user_id)
  values (v_conv, v_me);

  insert into public.conversation_participants (conversation_id, user_id)
  select v_conv, m from unnest(p_members) as m where m <> v_me;

  return v_conv;
end $$;

revoke all on function public.create_group_conversation(text, uuid[]) from public, anon;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 2) VIEW-ONCE MEDIA (WhatsApp style)
-- view_once: true = media disappears after the recipient views it
-- viewed_by:  user ids who have opened it (per-user enforcement)
-- ------------------------------------------------------------
alter table public.messages add column if not exists view_once boolean default false;
alter table public.messages add column if not exists viewed_by uuid[] default '{}';
