begin;

-- ============================================================
-- GEN Z — 20261023_06 — CHAT EXPIRY IS CLIENT-CONTROLLED
--
-- THE GAP
--
-- The "24 hours" send mode is entirely a client decision:
--
--   ConversationScreen.tsx L634
--     if (sendMode === 'temp24h')
--       return { expiresAt: new Date(Date.now() + TEMP_MS).toISOString() }
--
-- That value travels straight into messages.expires_at (api.ts L204).
-- Nothing in the database constrains it. A modified client can send a
-- "disappearing" message with expires_at a decade out, or with a
-- timestamp already in the past so it vanishes before the recipient
-- sees it, and the purge job will faithfully obey either.
--
-- Posts do not have this problem: enforce_48h_expiry() overwrites
-- expires_at on every write (expiry_v2.sql L22). Messages never got
-- the equivalent.
--
-- THE FIX
--
-- A BEFORE INSERT OR UPDATE trigger that treats the server clock as
-- authoritative:
--
--   INSERT  expires_at := created_at + min(requested, 24h)
--   UPDATE  expires_at := min(requested, created_at + 24h)
--
-- Shortening is allowed — a client asking for 5 minutes gets 5
-- minutes. Only EXTENDING beyond the ceiling is clamped. An already
-- expired value is left alone so the next purge sweep can collect it;
-- clamping it forward would resurrect a message the user meant to
-- drop.
--
-- messages.created_at is already server-set by the table default and
-- the update guard forbids changing it, so created_at is a trustworthy
-- anchor.
--
-- Why a separate trigger rather than editing messages_guard_update:
-- that function belongs to messaging_v2_hardening_v2.sql and is
-- re-created by it. A rewrite here would be silently undone by the
-- next run of that file. A separate trigger with its own name survives.
--
-- Idempotent. No existing row is modified by running this file.
-- ============================================================

create or replace function public.messages_clamp_expiry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ceiling timestamptz;
begin
  if new.expires_at is null then
    return new;
  end if;

  v_ceiling := coalesce(new.created_at, now()) + interval '24 hours';

  -- Already expired: leave it for the purge. Do not pull it forward.
  if new.expires_at <= now() then
    return new;
  end if;

  if new.expires_at > v_ceiling then
    new.expires_at := v_ceiling;
  end if;

  return new;
end $$;

revoke all on function public.messages_clamp_expiry() from public, anon, authenticated;

drop trigger if exists messages_clamp_expiry on public.messages;
create trigger messages_clamp_expiry
  before insert or update on public.messages
  for each row execute function public.messages_clamp_expiry();


-- ------------------------------------------------------------
-- VERIFY
-- ------------------------------------------------------------
select 'clamp_trigger' as check_name, count(*) as n
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname = 'messages' and t.tgname = 'messages_clamp_expiry';


-- ============================================================
-- ACCEPTANCE TEST (scratch conversation, do not use real threads)
--
--   insert into public.messages (conversation_id, sender_id, content, expires_at)
--   values ('<conv>', auth.uid(), 'x', now() + interval '30 days');
--   -- expect expires_at ~= created_at + 24 hours
--
--   insert into public.messages (conversation_id, sender_id, content, expires_at)
--   values ('<conv>', auth.uid(), 'x', now() + interval '5 minutes');
--   -- expect expires_at ~= now() + 5 minutes   (shortening is honoured)
--
--   update public.messages set expires_at = now() + interval '1 year'
--   where id = '<mid>';
--   -- expect expires_at unchanged at the 24h ceiling
-- ============================================================

commit;
