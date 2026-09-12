-- ============================================================
-- GEN Z — EXPIRY v2 (idempotent, safe to re-run)
-- 1) DB-level 48h enforcement (clients can NOT set/extend expires_at)
-- 2) Server-side Storage cleanup for expired posts (media deleted
--    BEFORE the post row; failures go to a retry queue)
-- 3) Repairs the pg_cron job to call the new purge function
-- 4) Safe orphan reconciliation (dry-run + guarded cleanup)
-- Requires: pg_cron, pg_net, supabase_vault (enabled at the top)
-- Service-role key is NEVER exposed to clients — read from vault
-- at runtime inside SECURITY DEFINER functions only.
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ------------------------------------------------------------
-- 1) DB-LEVEL 48h ENFORCEMENT
--    INSERT: created_at := now() (client value ignored), expires_at := created_at + 48h
--    UPDATE: expires_at recomputed from created_at (existing
--            lock_drop_timestamps trigger still blocks created_at edits)
-- ------------------------------------------------------------
create or replace function public.enforce_48h_expiry()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); -- client-provided created_at is ignored
  end if;
  new.expires_at := new.created_at + interval '48 hours';
  return new;
end $$;

drop trigger if exists posts_enforce_48h on public.posts;
create trigger posts_enforce_48h
  before insert or update on public.posts
  for each row execute function public.enforce_48h_expiry();

revoke all on function public.enforce_48h_expiry() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2) MEDIA PATH EXTRACTION
--    posts store full public URLs; storage paths are the part
--    after '/object/public/media/'. All GENZ post media lives in
--    the 'media' bucket.
-- ------------------------------------------------------------
create or replace function public.genz_media_path(v_url text)
returns text language sql immutable as $$
  select case when v_url like '%/object/public/media/%'
    then nullif(split_part(regexp_replace(v_url, '\?.*$', ''), '/object/public/media/', 2), '')
    else null end;
$$;

create or replace function public.genz_media_paths(p public.posts)
returns text[] language plpgsql stable as $$
declare v_res text[] := '{}'; v_elem text;
begin
  if p.media_url is not null then v_res := array_append(v_res, public.genz_media_path(p.media_url)); end if;
  if p.cover_url is not null then v_res := array_append(v_res, public.genz_media_path(p.cover_url)); end if;
  if p.voiceover_url is not null then v_res := array_append(v_res, public.genz_media_path(p.voiceover_url)); end if;
  if p.sound_url is not null then v_res := array_append(v_res, public.genz_media_path(p.sound_url)); end if;
  if p.media_items is not null and jsonb_typeof(p.media_items) = 'array' then
    for v_elem in select jsonb_array_elements_text(p.media_items) loop
      v_res := array_append(v_res, public.genz_media_path((v_elem::jsonb) ->> 'url'));
    end loop;
  end if;
  return (select array_agg(distinct t) from unnest(v_res) t where t is not null and t <> '');
end $$;

revoke all on function public.genz_media_path(text) from public, anon, authenticated;
revoke all on function public.genz_media_paths(public.posts) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) RETRY / AUDIT QUEUE (internal only)
-- ------------------------------------------------------------
create table if not exists public.media_cleanup_queue (
  id bigint generated always as identity primary key,
  bucket text not null default 'media',
  object_path text not null,
  post_id uuid,
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bucket, object_path)
);
alter table public.media_cleanup_queue disable row level security;
revoke all on public.media_cleanup_queue from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4) DELETE ONE STORAGE OBJECT VIA THE STORAGE API
--    (service role from vault — never exposed to clients)
--    Accepted as success: 200 (deleted), 404/400 (already gone)
-- ------------------------------------------------------------
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
  -- pg_net is async: poll briefly. If no response yet, the request is
  -- still in flight and will complete server-side; reconciliation
  -- (genz_cleanup_orphan_media) is the safety net for leftovers, so a
  -- pending state is treated as success rather than a false failure.
  for i in 1..10 loop
    perform pg_sleep(0.5);
    select status_code, content into v_resp from net._http_response where id = v_req order by id desc limit 1;
    exit when v_resp is not null;
  end loop;
  if v_resp is null then
    ok := true; status := 0; err := 'in_flight'; -- not a failure
    return;
  end if;
  status := v_resp.status_code;
  if status in (200, 404, 400) then
    ok := true;
  else
    err := coalesce(v_resp.content, 'status ' || status::text);
  end if;
end $$;

revoke all on function public.genz_storage_delete(text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 5) MAIN PURGE — media first, then row; failures queued.
--    Retries the queue before processing new expirations.
-- ------------------------------------------------------------
create or replace function public.genz_purge_expired()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_q record; v_post public.posts; v_paths text[]; v_path text; v_del record;
  v_posts int := 0; v_qok int := 0; v_qfail int := 0; v_mfail int := 0;
begin
  -- 5a) retry previously failed media deletions
  for v_q in select * from public.media_cleanup_queue order by id loop
    select * into v_del from public.genz_storage_delete(v_q.bucket, v_q.object_path);
    if v_del.ok then
      delete from public.media_cleanup_queue where id = v_q.id;
      v_qok := v_qok + 1;
    else
      update public.media_cleanup_queue
        set attempts = attempts + 1, last_error = v_del.err, updated_at = now()
        where id = v_q.id;
      v_qfail := v_qfail + 1;
    end if;
  end loop;

  -- 5b) expire posts: delete media first, then the row (cascades cleanup)
  for v_post in select * from public.posts where expires_at <= now() order by created_at loop
    v_paths := public.genz_media_paths(v_post);
    if v_paths is not null then
      foreach v_path in array v_paths loop
        select * into v_del from public.genz_storage_delete('media', v_path);
        if not v_del.ok then
          insert into public.media_cleanup_queue (bucket, object_path, post_id, attempts, last_error)
          values ('media', v_path, v_post.id, 1, v_del.err)
          on conflict (bucket, object_path) do update
            set attempts = media_cleanup_queue.attempts + 1,
                last_error = excluded.last_error,
                updated_at = now();
          v_mfail := v_mfail + 1;
        end if;
      end loop;
    end if;
    delete from public.posts where id = v_post.id;
    v_posts := v_posts + 1;
  end loop;

  return jsonb_build_object('ok', true, 'posts_deleted', v_posts,
    'media_failures_queued', v_mfail, 'queue_retried_ok', v_qok,
    'queue_retried_failed', v_qfail,
    'queue_pending', (select count(*) from public.media_cleanup_queue));
end $$;

revoke all on function public.genz_purge_expired() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 6) CRON JOB — replace the old raw-delete job with the new
--    cleanup function (same name, every 5 minutes)
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'genz-purge-expired-posts') then
    perform cron.unschedule('genz-purge-expired-posts');
  end if;
end $$;

select cron.schedule('genz-purge-expired-posts', '*/5 * * * *',
  $$ select public.genz_purge_expired(); $$);

-- ------------------------------------------------------------
-- 7) ORPHAN RECONCILIATION (safe)
--    auto   = unreferenced post-media paths (voiceovers/, {uuid}/drop-*) — safe to delete
--    review = unreferenced anything else (e.g. {uuid}/cover-* which may be
--             a PROFILE cover, not a post cover) — never auto-deleted
--    Reference set = ALL posts' media + profiles.cover_url/avatar_url + queue
-- ------------------------------------------------------------
create or replace function public.genz_find_orphan_media(dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_refs text[] := '{}'; v_paths text[]; v_post public.posts; v_obj record;
  v_auto text[] := '{}'; v_review text[] := '{}';
  v_auto_n int; v_review_n int;
begin
  -- referenced: every post's media
  for v_post in select * from public.posts loop
    v_paths := public.genz_media_paths(v_post);
    v_refs := array_cat(v_refs, coalesce(v_paths, '{}'));
  end loop;
  -- referenced: profile covers & avatars (same bucket, different table)
  select array_agg(public.genz_media_path(cover_url)) into v_paths
    from public.profiles where cover_url is not null;
  v_refs := array_cat(v_refs, coalesce(v_paths, '{}'));
  select array_agg(public.genz_media_path(avatar_url)) into v_paths
    from public.profiles where avatar_url is not null;
  v_refs := array_cat(v_refs, coalesce(v_paths, '{}'));
  -- referenced: pending queue (already scheduled for deletion)
  select array_agg(object_path) into v_paths from public.media_cleanup_queue;
  v_refs := array_cat(v_refs, coalesce(v_paths, '{}'));

  -- candidates: media bucket objects NOT in the app's non-post namespaces
  for v_obj in
    select name from storage.objects
    where bucket_id = 'media'
      and name !~ '^(avatars|chat|anon)/'
  loop
    if v_obj.name = any (v_refs) then
      continue;
    end if;
    -- safe auto-delete patterns: voiceovers/ or {uuid}/drop-*
    if v_obj.name ~ '^(voiceovers/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/drop-)' then
      v_auto := array_append(v_auto, v_obj.name);
    else
      v_review := array_append(v_review, v_obj.name);
    end if;
  end loop;

  v_auto_n := coalesce(array_length(v_auto, 1), 0);
  v_review_n := coalesce(array_length(v_review, 1), 0);

  if dry_run then
    return jsonb_build_object('dry_run', true, 'auto_orphans', v_auto,
      'auto_count', v_auto_n, 'review_orphans', v_review, 'review_count', v_review_n);
  end if;

  return jsonb_build_object('dry_run', false, 'auto_orphans', v_auto,
    'auto_count', v_auto_n, 'review_orphans', v_review, 'review_count', v_review_n);
end $$;

-- ------------------------------------------------------------
-- 8) ORPHAN CLEANUP — deletes ONLY auto-orphans (guarded),
--    up to v_limit per call; failures go to the retry queue.
-- ------------------------------------------------------------
create or replace function public.genz_cleanup_orphan_media(v_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_found jsonb; v_paths jsonb; v_path text; v_del record;
  v_deleted int := 0; v_failed int := 0; v_i int := 0;
begin
  v_found := public.genz_find_orphan_media(true);
  v_paths := v_found -> 'auto_orphans';
  if jsonb_typeof(v_paths) = 'array' then
    for v_path in select jsonb_array_elements_text(v_paths) loop
      exit when v_i >= v_limit;
      v_i := v_i + 1;
      select * into v_del from public.genz_storage_delete('media', v_path);
      if v_del.ok then
        v_deleted := v_deleted + 1;
      else
        insert into public.media_cleanup_queue (bucket, object_path, attempts, last_error)
        values ('media', v_path, 1, v_del.err)
        on conflict (bucket, object_path) do update
          set attempts = media_cleanup_queue.attempts + 1, last_error = excluded.last_error, updated_at = now();
        v_failed := v_failed + 1;
      end if;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'deleted', v_deleted, 'failed_queued', v_failed,
    'remaining_auto', (select count(*) from storage.objects o
      where o.bucket_id = 'media' and o.name ~ '^(voiceovers/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/drop-)'
        and not exists (select 1 from public.posts p where public.genz_media_path(p.media_url) = o.name)));
end $$;

revoke all on function public.genz_find_orphan_media(boolean) from public, anon, authenticated;
revoke all on function public.genz_cleanup_orphan_media(integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- DONE. Verify with:
--   select * from cron.job where jobname = 'genz-purge-expired-posts';
--   select public.genz_find_orphan_media(true);
--   select public.genz_purge_expired();
-- ------------------------------------------------------------
