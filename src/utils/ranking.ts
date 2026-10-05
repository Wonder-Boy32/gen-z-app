import { supabase } from '../supabase/client';

/**
 * The single definition of "hot" in this app.
 *
 * These lived inside FeedScreen — twice. Once as `velocityOf` inside rankRows and
 * once written out inline while building the pulse map. Discover now needs the
 * same number to rank creators, and two copies of a ranking formula drift: the two
 * surfaces would quietly disagree about what is rising, which is exactly the
 * confusion this refactor exists to remove. One definition, one place to tune.
 */

export type Pulse = {
  views30: number;
  likes30: number;
  comments30: number;
  rising: boolean;
  trending: boolean;
};

/** Neutral value for a post with no counters in the window. */
export const EMPTY_PULSE: Pulse = {
  views30: 0,
  likes30: 0,
  comments30: 0,
  rising: false,
  trending: false,
};

/** The rolling window, in minutes, that "velocity" means everywhere in the app. */
export const RISING_WINDOW_MIN = 30;

/** Thresholds for calling a post "rising" inside that window. */
export const MIN_VIEWS_RISING = 20;
export const MIN_ENGAGEMENT_RISING = 2;

/**
 * 30-minute engagement velocity.
 * Views are cheap to produce (and to bot), comments cost the most effort — the
 * weights are ordered that way on purpose.
 */
export const velocityOf = (p: Pulse): number => p.views30 * 0.7 + p.likes30 * 2.2 + p.comments30 * 3.2;

/**
 * Lifetime engagement, log-dampened so a single old megapost cannot dominate the
 * rankings forever. Log on likes/comments (they saturate) but not on views, which
 * are already scaled down hard.
 */
export const engagementOf = (r: {
  likes_count: number;
  comments_count: number;
  views_count: number;
}): number => Math.log1p(r.likes_count) * 1.1 + Math.log1p(r.comments_count) * 1.6 + r.views_count * 0.03;

/**
 * Load the rolling counters for a set of post ids.
 *
 * Reads the same three event tables FeedScreen has always used
 * (`post_view_counts`, `like_counts`, `comment_counts`). Callers should pass every
 * id they already hold — one call, three queries, regardless of how many ids.
 */
export async function loadPulse(ids: string[]): Promise<Map<string, Pulse>> {
  const map = new Map<string, Pulse>();
  const unique = [...new Set(ids)];
  if (!unique.length) return map;

  const since = new Date(Date.now() - RISING_WINDOW_MIN * 60 * 1000).toISOString();

  const [pv, lk, cm] = await Promise.all([
    supabase.from('post_view_counts').select('post_id').in('post_id', unique).gte('viewed_at', since).limit(3000),
    supabase.from('like_counts').select('post_id').in('post_id', unique).gte('created_at', since).limit(3000),
    supabase.from('comment_counts').select('post_id').in('post_id', unique).gte('created_at', since).limit(3000),
  ]);

  const tally = (arr: { post_id: string }[] | null) => {
    const m = new Map<string, number>();
    (arr ?? []).forEach((x) => m.set(x.post_id, (m.get(x.post_id) ?? 0) + 1));
    return m;
  };
  const views30 = tally(pv.data);
  const likes30 = tally(lk.data);
  const comments30 = tally(cm.data);

  unique.forEach((id) => {
    map.set(id, {
      views30: views30.get(id) ?? 0,
      likes30: likes30.get(id) ?? 0,
      comments30: comments30.get(id) ?? 0,
      rising: false,
      trending: false,
    });
  });

  // "Trending" is the top 5 by velocity among the posts we were handed — ranked
  // through velocityOf() rather than a second copy of the formula.
  const ranked = [...map.entries()].sort((a, b) => velocityOf(b[1]) - velocityOf(a[1]));
  const trendingSet = new Set(ranked.slice(0, 5).map(([id]) => id));

  map.forEach((p, id) => {
    p.rising = p.views30 >= MIN_VIEWS_RISING && p.likes30 + p.comments30 >= MIN_ENGAGEMENT_RISING;
    p.trending = trendingSet.has(id);
  });

  return map;
}
