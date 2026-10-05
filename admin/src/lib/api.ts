import { supabase } from './supabase';

export class ApiError extends Error {}

async function rpc<T = unknown>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(error.message);
  return data as T;
}

// ---- shared types -------------------------------------------------------
export interface Whoami {
  user_id: string;
  email: string;
  role: string;
  status: string;
  mfa_enabled: boolean;
  permissions: string[];
}

export interface Overview {
  total_users: number;
  active_users: number;
  active_drops: number;
  drops_today: number;
  expiring_soon: number;
  messages_today: number;
  anon_today: number;
  pending_reports: number;
}

export interface Pulse {
  active_drops: number;
  rising_drops: number;
  new_drops: number;
  expiring_6h: number;
  expiring_1h: number;
  expired_today: number;
  total_views: number;
  total_interactions: number;
  top_rising: { id: string; creator: string; caption: string | null; likes_count: number; comments_count: number; views: number }[];
}

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  account_status: string;
  verified: boolean;
  anon_disabled: boolean;
  location_region: string | null;
  created_at: string;
  last_seen_at: string | null;
  followers: number;
  following: number;
  active_drops: number;
  open_reports: number;
}

export interface UserDetail {
  user: UserRow;
  drops: any[];
  reports: any[];
  history: any[];
}

export interface DropRow {
  id: string;
  user_id: string;
  creator: string;
  media_type: string | null;
  caption: string | null;
  content: string | null;
  created_at: string;
  expires_at: string;
  likes_count: number;
  comments_count: number;
  removed_at: string | null;
  visibility: string;
  location: string | null;
  views: number;
  reposts: number;
  saves: number;
  open_reports: number;
}

export interface ReportRow {
  id: string;
  reason: string;
  note: string | null;
  severity: string;
  status: string;
  created_at: string;
  assigned_to: string | null;
  resolution: string | null;
  resolved_at: string | null;
  reporter: string | null;
  reported_user: string | null;
  post_id: string | null;
  comment_id: string | null;
  reported_user_id: string | null;
  drop_caption: string | null;
  drop_type: string | null;
  drop_removed: string | null;
  comment_content: string | null;
}

export interface AnonReport {
  id: string;
  reason: string;
  note: string | null;
  severity: string;
  status: string;
  created_at: string;
  resolution: string | null;
  content: string | null;
  message_type: string;
  message_created_at: string;
  recipient: string | null;
  internal_sender: string | null; // server-side only — never user-visible
}

export interface ChatReport {
  id: string;
  severity: string;
  status: string;
  created_at: string;
  resolution: string | null;
  reporter: string | null;
  reported_user: string | null;
  conversation_id: string;
  message_content: string | null;
  message_type: string | null;
  message_created_at: string | null;
  participants: number;
}

export interface SettingRow { key: string; value: any; category: string; label: string | null; description: string | null; is_safe: boolean; updated_at: string; }
export interface FlagRow { key: string; state: string; rollout_type: string; rollout_value: string | null; updated_at: string; updated_by: string | null; }
export interface NotificationRow { id: string; title: string; message: string; audience_type: string; audience_value: string | null; scheduled_for: string | null; status: string; created_at: string; sent_at: string | null; delivered: number; }
export interface AdminRow { user_id: string; email: string; role: string; status: string; mfa_enabled: boolean; created_at: string; last_login_at: string | null; }
export interface AuditEntry { admin_email: string | null; action: string; category: string; target_type: string | null; target_id: string | null; reason: string | null; metadata: any; ip: string | null; created_at: string; }
export interface SeriesPoint { day: string; new_users: number; drops_created: number; drops_expired: number; views: number; likes: number; comments: number; reposts: number; saves: number; follows: number; messages: number; anon_messages: number; reports: number; dau: number; }
export interface Snapshot { wau: number; mau: number; retention_7d: number; total_drops_viewed: number; total_likes: number; total_comments: number; total_reposts: number; total_saves: number; total_follows: number; total_conversations: number; total_messages: number; total_anon_messages: number; total_bans: number; total_suspensions: number; total_reports: number; }

export interface AlertSummary {
  unresolved: number;
  verification: number;
  payments: number;
  reports: number;
}

export interface AdminAlert {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  target_type: string | null;
  target_id: string | null;
  actor_id: string | null;
  route: string | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  actor_username: string | null;
}

export interface VerificationRequestRow {
  id: string;
  user_id: string;
  display_name: string | null;
  reason: string;
  links: string | null;
  status: string;
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  username: string | null;
  avatar_url: string | null;
  verified: boolean | null;
}

export interface GenZPlusPaymentRow {
  id: string;
  user_id: string;
  username: string | null;
  reference: string;
  amount_kobo: number;
  note: string | null;
  created_at: string;
}

// ---- API ----------------------------------------------------------------
export const api = {
  whoami: () => rpc<Whoami>('admin_whoami'),
  statsOverview: () => rpc<Overview>('admin_stats_overview'),
  pulse: () => rpc<Pulse>('admin_pulse'),
  analyticsSeries: (days: number) => rpc<{ series: SeriesPoint[] }>('admin_analytics_series', { p_days: days }),
  analyticsSnapshot: () => rpc<Snapshot>('admin_analytics_snapshot'),
  regions: () => rpc<{ regions: any[]; drop_locations: any[] }>('admin_regions'),
  discovery: () => rpc<any>('admin_discovery'),
  safety: () => rpc<any>('admin_safety_overview'),

  userList: (search?: string, status?: string) => rpc<{ users: UserRow[] }>('admin_user_list', { p_search: search ?? null, p_status: status ?? null, p_limit: 60, p_offset: 0 }),
  userDetail: (id: string) => rpc<UserDetail>('admin_user_detail', { p_user_id: id }),
  userSetStatus: (id: string, status: string, reason: string) => rpc('admin_user_set_status', { p_user_id: id, p_status: status, p_reason: reason }),
  userSetVerified: (id: string, verified: boolean, reason: string) => rpc('admin_user_set_verified', { p_user_id: id, p_verified: verified, p_reason: reason }),
  userSetAnon: (id: string, disabled: boolean, reason: string) => rpc('admin_user_set_anon', { p_user_id: id, p_disabled: disabled, p_reason: reason }),

  dropList: (filter: string, search?: string) => rpc<{ drops: DropRow[] }>('admin_drop_list', { p_filter: filter, p_search: search ?? null, p_limit: 60, p_offset: 0 }),
  dropRemove: (id: string, reason: string) => rpc('admin_drop_remove', { p_post_id: id, p_reason: reason }),
  dropRestore: (id: string, reason: string) => rpc('admin_drop_restore', { p_post_id: id, p_reason: reason }),

  reportList: (severity?: string, status = 'open') => rpc<{ reports: ReportRow[] }>('admin_report_list', { p_severity: severity ?? null, p_status: status, p_limit: 60, p_offset: 0 }),
  reportResolve: (id: string, action: string, reason: string) => rpc('admin_report_resolve', { p_report_id: id, p_action: action, p_reason: reason }),
  reportAssign: (id: string, assignee: string) => rpc('admin_report_assign', { p_report_id: id, p_assignee_id: assignee }),

  anonReports: (status = 'open') => rpc<{ reports: AnonReport[] }>('admin_anon_report_list', { p_status: status, p_limit: 60, p_offset: 0 }),
  anonResolve: (id: string, action: string, reason: string) => rpc('admin_anon_resolve', { p_report_id: id, p_action: action, p_reason: reason }),

  chatReports: (status = 'open') => rpc<{ reports: ChatReport[] }>('admin_chat_report_list', { p_status: status, p_limit: 60, p_offset: 0 }),
  chatResolve: (id: string, action: string, reason: string) => rpc('admin_chat_resolve', { p_report_id: id, p_action: action, p_reason: reason }),

  notifications: () => rpc<{ notifications: NotificationRow[] }>('admin_notification_list'),
  notificationCreate: (title: string, message: string, audience: string, value: string | null, scheduled: string | null) =>
    rpc('admin_notification_create', { p_title: title, p_message: message, p_audience_type: audience, p_audience_value: value, p_scheduled_for: scheduled }),
  notificationSend: (id: string) => rpc('admin_notification_send', { p_id: id }),
  notificationCancel: (id: string) => rpc('admin_notification_cancel', { p_id: id }),

  chains: () => rpc<{ chains: any[] }>('admin_chain_list', { p_limit: 60, p_offset: 0 }),

  settings: () => rpc<{ settings: SettingRow[] }>('admin_setting_list'),
  settingSet: (key: string, value: unknown) => rpc('admin_setting_set', { p_key: key, p_value: JSON.stringify(value) }),
  flags: () => rpc<{ flags: FlagRow[] }>('admin_flag_list'),
  flagSet: (key: string, state: string, rollout: string, value: string | null) =>
    rpc('admin_flag_set', { p_key: key, p_state: state, p_rollout_type: rollout, p_rollout_value: value }),

  audit: (category?: string) => rpc<{ entries: AuditEntry[] }>('admin_audit_list', { p_category: category ?? null, p_limit: 150, p_offset: 0 }),
  admins: () => rpc<{ admins: AdminRow[] }>('admin_admin_list'),
  adminAdd: (email: string, role: string) => rpc('admin_admin_add', { p_email: email, p_role: role }),
  adminRemove: (id: string) => rpc('admin_admin_remove', { p_user_id: id }),
  adminSetRole: (id: string, role: string) => rpc('admin_admin_set_role', { p_user_id: id, p_role: role }),
  mfaStatus: (enabled: boolean) => rpc('admin_mfa_status', { p_enabled: enabled }),

  // ---- GenZ+ payments (supabase/genzplus_opay.sql) ----
  // Members transfer ₦20,000 by OPay and submit a reference; an admin confirms it.
  // A `returns table` function arrives as a plain array, not a wrapper object.
  genzplusPending: (limit = 100) =>
    rpc<GenZPlusPaymentRow[]>('genzplus_pending_payments', { p_limit: limit }),
  genzplusReview: (id: string, approve: boolean, note: string) =>
    rpc<{ ok?: boolean; error?: string; approved?: boolean }>('genzplus_review_payment', {
      p_payment: id,
      p_approve: approve,
      p_note: note,
    }),

  // ---- Verification queue (supabase/admin_verification_queue.sql) ----
  // verification_requests.sql has NO update policy by design, so an application
  // can only be decided through a SECURITY DEFINER function. Until these
  // existed there was no such function at all: applications were collected and
  // then unreadable by every admin.
  // Unwrapped to a plain array deliberately. The RPC returns
  // `jsonb_build_object('requests', …)`, but leaving that wrapper on the return
  // type makes `useLoad` infer `{ requests } | never[]` — a union with no
  // `.map`/`.length`, which is a type error at every use site. Every other list
  // screen here consumes a plain array (see genzplusPending above), so this
  // matches the established shape.
  verificationQueue: async (status: string | null = 'pending') => {
    const res = await rpc<{ requests: VerificationRequestRow[] }>('admin_verification_list', {
      p_status: status,
      p_limit: 100,
      p_offset: 0,
    });
    return res?.requests ?? [];
  },
  verificationReview: (id: string, approve: boolean, note: string) =>
    rpc<{ ok?: boolean; error?: string; approved?: boolean }>('admin_verification_resolve', {
      p_request: id,
      p_approve: approve,
      p_note: note,
    }),

  // ---- Admin alerts (supabase/admin_alerts.sql) ----
  // The direction that was missing: users -> admins. admin_notifications is an
  // admin writing to users; nothing existed the other way, so a submitted
  // verification application was invisible until someone opened the right
  // screen by luck. `alertSummary` drives the bell and every nav badge.
  alertSummary: () => rpc<AlertSummary>('admin_alert_summary'),
  alertList: async (limit = 50) => {
    const res = await rpc<{ alerts: AdminAlert[] }>('admin_alert_list', { p_limit: limit });
    return res?.alerts ?? [];
  },
  alertAck: (id: string) => rpc<{ ok?: boolean }>('admin_alert_ack', { p_id: id }),
};
