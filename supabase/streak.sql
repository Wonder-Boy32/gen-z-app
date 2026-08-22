-- ============================================================
-- Gen Z — streaks engine (RUN THIS in Supabase SQL editor)
-- Every message bumps the streak for ALL participants of the
-- conversation: +1 if they messaged yesterday, reset to 1 if
-- they missed a day, unchanged if they already messaged today.
-- ============================================================

create or replace function public.bump_streaks()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p uuid;
begin
  for p in
    select cp.user_id
    from public.conversation_participants cp
    where cp.conversation_id = new.conversation_id
  loop
    update public.profiles set
      streak_count = case
        when last_streak_date = current_date then streak_count
        when last_streak_date = current_date - 1 then streak_count + 1
        else 1
      end,
      last_streak_date = current_date
    where id = p;
  end loop;
  return new;
end;
$$;

drop trigger if exists messages_bump_streaks on public.messages;
create trigger messages_bump_streaks
  after insert on public.messages
  for each row execute function public.bump_streaks();

-- Sanity check after running:
-- select id, username, streak_count, last_streak_date from public.profiles;
