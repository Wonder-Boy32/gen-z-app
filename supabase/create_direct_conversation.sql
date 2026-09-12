-- ============================================================
-- Gen Z - CREATE DIRECT CONVERSATION RPC (run ONCE)
-- Why: client-side inserts into conversations/participants kept
--      failing RLS checks. This SECURITY DEFINER function runs
--      as the table owner, bypassing RLS entirely, and creates
--      the conversation + both participants atomically.
-- The app calls: supabase.rpc('create_direct_conversation',
--                { p_other: <other user id> })
-- ============================================================

create or replace function public.create_direct_conversation(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_conv uuid;
begin
  if v_me is null then
    raise exception 'not authenticated';
  end if;
  if p_other is null or p_other = v_me then
    raise exception 'invalid participant';
  end if;

  -- return the existing direct conversation if there is one
  select cp1.conversation_id into v_conv
  from public.conversation_participants cp1
  join public.conversation_participants cp2 on cp2.conversation_id = cp1.conversation_id
  where cp1.user_id = v_me and cp2.user_id = p_other
  limit 1;
  if v_conv is not null then
    return v_conv;
  end if;

  insert into public.conversations (type) values ('direct') returning id into v_conv;
  insert into public.conversation_participants (conversation_id, user_id)
    values (v_conv, v_me), (v_conv, p_other);
  return v_conv;
end;
$$;

revoke all on function public.create_direct_conversation(uuid) from public, anon;
grant execute on function public.create_direct_conversation(uuid) to authenticated;
