import { supabase } from '../supabase/client';

export type NotifyType = 'follow' | 'like' | 'comment' | 'reply' | 'reaction' | 'repost';

type NotifyOpts = {
  /** recipient of the notification */
  userId: string;
  /** the person who performed the action */
  actorId: string;
  type: NotifyType;
  postId?: string | null;
  commentId?: string | null;
};

/**
 * Fire-and-forget notification. Skips self-actions entirely and
 * never throws — notifications are best-effort.
 */
export async function notifyUser({ userId, actorId, type, postId, commentId }: NotifyOpts) {
  if (!userId || !actorId || userId === actorId) return;
  try {
    await supabase.from('notifications').insert({
      user_id: userId,
      actor_id: actorId,
      type,
      post_id: postId ?? null,
      comment_id: commentId ?? null,
    });
  } catch {
    // non-fatal
  }
}
