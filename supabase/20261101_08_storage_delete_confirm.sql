-- ============================================================
-- GEN Z — expired media must not survive its own deletion
--
-- THE DEFECT
--   public.genz_storage_delete() fires the Storage API DELETE through
--   pg_net and then polls net._http_response for at most 5 seconds
--   (10 x 0.5s). If no response has arrived by then it returns:
--
--       ok := true; status := 0; err := 'in_flight';  -- not a failure
--
--   genz_purge_expired() reads ok = true as "media deleted", deletes the
--   post row, and never touches media_cleanup_queue. So a slow request
--   is indistinguishable from a successful one, and the retry queue —
--   the entire safety net — is bypassed precisely when it is needed.
--
--   Measured on production before this fix: posts = 0 rows, but 46
--   unreferenced post-media objects were still sitting in the PUBLIC
--   `media` bucket and still downloadable by URL, while
--   media_cleanup_queue held 0 rows. Expired Drops had outlived their
--   seven days. (Cleaned up out-of-band with
--   scripts/cleanup-orphan-media.mjs; this file stops it recurring.)
--
-- THE FIX
--   "No response within the poll window" becomes ok = false. The caller
--   already handles that correctly: it inserts the path into
--   media_cleanup_queue, and the next cron run retries it. A retry that
--   finds the object already gone gets 404, which is accepted as
--   success, so the queue drains either way. Being pessimistic here is
--   self-healing; being optimistic was not.
--
-- SAFETY
--   Replaces one function body. No data touched, no table changed,
--   no cron job altered. Idempotent.
-- ============================================================

create or replace function public.genz_storage_delete(v_bucket text, v_path text,
  out ok boolean, out status int, out err text)
language plpgsql security definer set search_path = public as $$
declare v_url text; v_key text; v_req bigint; v_resp record;
begin
  ok := false; status := 0; err := null;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'auth_project_url' limit 1;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'auth_service_key' limit 1;
  if v_url is null or v_key is null then
    err := 'vault secrets (auth_project_url/auth_service_key) missing';
    return;
  end if;
  v_req := net.http_delete(
    url := v_url || '/storage/v1/object/' || v_bucket || '/' || v_path,
    headers := jsonb_build_object('apikey', v_key, 'Authorization', 'Bearer ' || v_key),
    timeout_milliseconds := 15000
  );
  -- pg_net is async. Poll, but do NOT assume success on silence: an
  -- unconfirmed delete is exactly how an expired Drop's bytes outlive
  -- its row. Silence = "not proven deleted" = caller must queue it.
  for i in 1..10 loop
    perform pg_sleep(0.5);
    select status_code, content into v_resp from net._http_response where id = v_req order by id desc limit 1;
    exit when v_resp is not null;
  end loop;
  if v_resp is null then
    ok := false;
    status := 0;
    err := 'no_response_in_poll_window (queued for retry)';
    return;
  end if;
  status := v_resp.status_code;
  -- 200 deleted, 404/400 already gone: all three mean "the object is not there".
  if status in (200, 404, 400) then
    ok := true;
  else
    err := coalesce(v_resp.content, 'status ' || status::text);
  end if;
end $$;

revoke all on function public.genz_storage_delete(text, text) from public, anon, authenticated;


-- ------------------------------------------------------------
-- PROOF — the branch that caused the leak must be gone.
-- ------------------------------------------------------------
do $$
declare v_src text;
begin
  select prosrc into v_src
    from pg_proc
   where proname = 'genz_storage_delete'
     and pronamespace = 'public'::regnamespace;

  if v_src is null then
    raise exception 'proof failed: genz_storage_delete() not found';
  end if;

  if v_src ilike '%err := ''in_flight''%' then
    raise exception 'proof failed: the assume-success in_flight branch is still present';
  end if;

  if v_src not ilike '%no_response_in_poll_window%' then
    raise exception 'proof failed: the pessimistic branch was not written';
  end if;

  raise notice 'storage delete now reports an unconfirmed delete as a failure, so the queue retries it';
end $$;
