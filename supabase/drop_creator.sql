-- ============================================================
-- GEN Z — Creator workflow (RUN THIS after schema.sql)
-- Drop metadata: visibility, interaction toggles, sound,
-- text layers, stickers, effects, filters, voiceover, location.
-- Drafts + sounds catalog. createdAt/expiresAt stay immutable.
-- The 48-hour rule is untouched: expires_at = created_at + 48h.
-- ============================================================

-- ---- Drop metadata ----
alter table public.posts add column if not exists visibility text not null default 'everyone'
  check (visibility in ('everyone', 'followers', 'only_me'));
alter table public.posts add column if not exists allow_likes boolean not null default true;
alter table public.posts add column if not exists allow_comments boolean not null default true;
alter table public.posts add column if not exists allow_shares boolean not null default true;
alter table public.posts add column if not exists allow_reposts boolean not null default true;
alter table public.posts add column if not exists allow_downloads boolean not null default true;
alter table public.posts add column if not exists allow_mentions boolean not null default true;
alter table public.posts add column if not exists sound text;
alter table public.posts add column if not exists text_layers jsonb;
alter table public.posts add column if not exists stickers jsonb;
alter table public.posts add column if not exists effects jsonb;
alter table public.posts add column if not exists filters jsonb;
alter table public.posts add column if not exists voiceover_url text;
alter table public.posts add column if not exists location text;
alter table public.posts add column if not exists mentions jsonb;

-- ---- Drafts (drafts NEVER start the 48h timer) ----
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
-- one draft per user (the app upserts with onConflict 'user_id')
create unique index if not exists drafts_user_idx on public.drafts (user_id);
alter table public.drafts enable row level security;
drop policy if exists "drafts_select" on public.drafts;
create policy "drafts_select" on public.drafts for select using (auth.uid() = user_id);
drop policy if exists "drafts_insert" on public.drafts;
create policy "drafts_insert" on public.drafts for insert with check (auth.uid() = user_id);
drop policy if exists "drafts_update" on public.drafts;
create policy "drafts_update" on public.drafts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "drafts_delete" on public.drafts;
create policy "drafts_delete" on public.drafts for delete using (auth.uid() = user_id);

-- ---- createdAt / expiresAt are IMMUTABLE ----
create or replace function public.lock_drop_timestamps()
returns trigger language plpgsql as $$
begin
  if new.created_at is distinct from old.created_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'createdAt and expiresAt are immutable (48h rule)';
  end if;
  return new;
end;
$$;
drop trigger if exists posts_lock_timestamps on public.posts;
create trigger posts_lock_timestamps
  before update on public.posts
  for each row execute function public.lock_drop_timestamps();

-- ---- Feed RLS: visibility + private accounts + 48h ----
drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts
  for select using (
    expires_at > now()
    and (
      user_id = auth.uid()
      or (
        visibility in ('everyone', 'followers')
        and (
          not exists (
            select 1 from public.profiles pr
            where pr.id = posts.user_id and pr.is_private
          )
          or exists (
            select 1 from public.follows f
            where f.following_id = posts.user_id
              and f.follower_id = auth.uid()
              and f.status = 'accepted'
          )
        )
      )
      or (
        visibility = 'only_me' and user_id = auth.uid()
      )
    )
  );

-- ---- Sounds catalog ----
create table if not exists public.sounds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  artist text,
  category text not null default 'Viral',
  usage_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.sounds enable row level security;
drop policy if exists "sounds_select" on public.sounds;
create policy "sounds_select" on public.sounds for select using (true);

insert into public.sounds (name, artist, category) values
  ('Midnight Drive', 'GEN Z Originals', 'Chill'),
  ('Vibe Check', 'DJ Blaze', 'Afrobeats'),
  ('No Wahala', 'Lagos Vibes', 'Afrobeats'),
  ('Amapiano Groove', 'KwaKwa Beats', 'Amapiano'),
  ('Heart on Sleeve', 'Riya', 'R&B'),
  ('Late Night Call', 'Neo', 'R&B'),
  ('City Lights', 'MetroKid', 'Hip-Hop'),
  ('Slay Mode', 'Queen T', 'Viral'),
  ('Old School Love', 'The Riddim', 'Retro'),
  ('Glow Up', 'Aura', 'Pop'),
  ('Original Sound 001', 'GEN Z Community', 'Original Sounds'),
  ('Trill Wave', 'Amapiano', 'Amapiano')
on conflict do nothing;

-- bump usage when a drop uses a sound
create or replace function public.bump_sound_usage()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sound is not null then
    update public.sounds set usage_count = usage_count + 1 where name = new.sound;
  end if;
  return new;
end;
$$;
drop trigger if exists posts_bump_sound on public.posts;
create trigger posts_bump_sound
  after insert on public.posts
  for each row when (new.sound is not null)
  execute function public.bump_sound_usage();
