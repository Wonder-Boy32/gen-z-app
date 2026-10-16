import { supabase } from '../supabase/client';

export type NotifyType =
  | 'follow'
  | 'like'
  | 'comment'
  | 'reply'
  | 'reaction'
  | 'repost'
  | 'comment_like'
  | 'anon_message'
  | 'call'
  // Security: the account was signed in on another device. Written by the
  // register_signin() RPC, never by notifyUser() — there is no actor to notify
  // on behalf of, the alert is addressed to the account owner about their own
  // account, so the row is self-authored by design.
  | 'new_login'
  // local-only: "your post finished uploading". Never stored, never sent to
  // another user — it is shown by the app to the person who posted.
  | 'upload';

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
