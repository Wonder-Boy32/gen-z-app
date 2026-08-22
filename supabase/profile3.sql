-- ============================================================
-- Gen Z — Profile 3.0 (RUN THIS after schema.sql)
-- Verified/location/pronouns, privacy toggles, reposts,
-- muted accounts, hidden words, notification prefs.
-- ============================================================

-- profile identity + privacy
alter table public.profiles add column if not exists verified boolean not null default false;
alter table public.profiles add column if not exists location text;
alter table public.profiles add column if not exists pronouns text;
alter table public.profiles add column if not exists message_who text not null default 'everyone'
  check (message_who in ('everyone', 'followers', 'nobody'));
alter table public.profiles add column if not exists comment_who text not null default 'everyone'
  check (comment_who in ('everyone', 'followers', 'nobody'));
alter table public.profiles add column if not exists mention_who text not null default 'everyone'
  check (mention_who in ('everyone', 'followers', 'nobody'));
alter table public.profiles add column if not exists activity_status boolean not null default true;
alter table public.profiles add column if not exists theme text not null default 'dark'
  check (theme in ('dark', 'light', 'system'));

-- REPOSTS (48h rule: the original post's expires_at governs visibility)
create table if not exists public.reposts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
alter table public.reposts enable row level security;
drop policy if exists "reposts_select" on public.reposts;
create policy "reposts_select" on public.reposts for select using (true);
drop policy if exists "reposts_insert" on public.reposts;
create policy "reposts_insert" on public.reposts for insert with check (auth.uid() = user_id);
drop policy if exists "reposts_delete" on public.reposts;
create policy "reposts_delete" on public.reposts for delete using (auth.uid() = user_id);

-- MUTED ACCOUNTS
create table if not exists public.muted_accounts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  muted_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id)
);
alter table public.muted_accounts enable row level security;
drop policy if exists "muted_select" on public.muted_accounts;
create policy "muted_select" on public.muted_accounts for select using (auth.uid() = user_id);
drop policy if exists "muted_insert" on public.muted_accounts;
create policy "muted_insert" on public.muted_accounts for insert with check (auth.uid() = user_id);
drop policy if exists "muted_delete" on public.muted_accounts;
create policy "muted_delete" on public.muted_accounts for delete using (auth.uid() = user_id);

-- HIDDEN WORDS
create table if not exists public.hidden_words (
  user_id uuid not null references public.profiles(id) on delete cascade,
  word text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, word)
);
alter table public.hidden_words enable row level security;
drop policy if exists "hidden_select" on public.hidden_words;
create policy "hidden_select" on public.hidden_words for select using (auth.uid() = user_id);
drop policy if exists "hidden_insert" on public.hidden_words;
create policy "hidden_insert" on public.hidden_words for insert with check (auth.uid() = user_id);
drop policy if exists "hidden_delete" on public.hidden_words;
create policy "hidden_delete" on public.hidden_words for delete using (auth.uid() = user_id);

-- NOTIFICATION PREFS (ready for when push arrives)
create table if not exists public.settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  notif_likes boolean not null default true,
  notif_comments boolean not null default true,
  notif_followers boolean not null default true,
  notif_messages boolean not null default true,
  notif_mentions boolean not null default true
);
alter table public.settings enable row level security;
drop policy if exists "settings_select" on public.settings;
create policy "settings_select" on public.settings for select using (auth.uid() = user_id);
drop policy if exists "settings_insert" on public.settings;
create policy "settings_insert" on public.settings for insert with check (auth.uid() = user_id);
drop policy if exists "settings_update" on public.settings;
create policy "settings_update" on public.settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
