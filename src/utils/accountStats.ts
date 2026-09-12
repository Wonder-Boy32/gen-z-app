import { supabase } from '../supabase/client';

/**
 * Per-stat numbers for the Settings hero card. Each value is `null` when its
 * query failed, so the UI can hide that stat instead of showing a wrong 0.
 */
export type AccountStats = {
  followers: number | null;
  following: number | null;
  posts: number | null;
  comments: number | null;
  likesGiven: number | null;
  lifetimeLikes: number | null;
};

export type AccountSnapshot = {
  exported_at: string;
  account: {
    id: string | null;
    email: string | null;
    provider: string | null;
    created_at: string | null;
    last_sign_in_at: string | null;
    email_confirmed_at: string | null;
  };
  profile: Record<string, unknown> | null;
  stats: AccountStats;
  notification_prefs: Record<string, unknown> | null;
};

export async function fetchAccountStats(userId: string): Promise<AccountStats> {
  const head = { count: 'exact' as const, head: true };
  const [followers, following, posts, comments, likesGiven] = await Promise.all([
    supabase.from('follows').select('following_id', head).eq('follower_id', userId),
    supabase.from('follows').select('follower_id', head).eq('following_id', userId),
    supabase.from('posts').select('id', head).eq('user_id', userId),
    supabase.from('comments').select('id', head).eq('user_id', userId),
    supabase.from('likes').select('post_id', head).eq('user_id', userId),
  ]);

  // lifetime_likes gets its own query on purpose: the column is added by a
  // separate migration, and a failed select here must not take the other
  // stats down with it (that is what blanked out profiles before).
  let lifetimeLikes: number | null = null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('lifetime_likes')
      .eq('id', userId)
      .maybeSingle();
    if (!error) lifetimeLikes = (data as { lifetime_likes?: number } | null)?.lifetime_likes ?? 0;
  } catch {
    lifetimeLikes = null;
  }

  return {
    followers: followers.error ? null : followers.count ?? null,
    following: following.error ? null : following.count ?? null,
    posts: posts.error ? null : posts.count ?? null,
    comments: comments.error ? null : comments.count ?? null,
    likesGiven: likesGiven.error ? null : likesGiven.count ?? null,
    lifetimeLikes,
  };
}

export async function buildAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  const authRes = await supabase.auth.getUser();
  const user = authRes.data.user;

  const [profRes, prefsRes, stats] = await Promise.all([
    supabase
      .from('profiles')
      .select('username, display_name, bio, location, pronouns, avatar_url, is_private, verified, created_at')
      .eq('id', userId)
      .maybeSingle(),
    supabase.from('settings').select('*').eq('user_id', userId).maybeSingle(),
    fetchAccountStats(userId),
  ]);

  return {
    exported_at: new Date().toISOString(),
    account: {
      id: user?.id ?? null,
      email: user?.email ?? null,
      provider: (user?.app_metadata as { provider?: string } | undefined)?.provider ?? null,
      created_at: user?.created_at ?? null,
      last_sign_in_at: user?.last_sign_in_at ?? null,
      email_confirmed_at: user?.email_confirmed_at ?? null,
    },
    profile: (profRes.data as Record<string, unknown> | null) ?? null,
    stats,
    notification_prefs: (prefsRes.data as Record<string, unknown> | null) ?? null,
  };
}
