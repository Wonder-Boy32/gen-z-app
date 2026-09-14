// Module registry — the future-proof admin architecture.
// Every product feature gets its own module entry here, with the
// permission(s) required to see it. New features = add one row.
export interface AdminModule {
  key: string;
  label: string;
  icon: string;
  perm: string;
  section: 'main' | 'content' | 'insights' | 'system';
  mobile: boolean; // shown in the bottom nav vs the More sheet
}

export const MODULES: AdminModule[] = [
  { key: 'overview', label: 'Dashboard', icon: 'grid', perm: 'dashboard.view', section: 'main', mobile: true },
  { key: 'pulse', label: '48H Pulse', icon: 'activity', perm: 'pulse.view', section: 'main', mobile: true },
  { key: 'users', label: 'Users', icon: 'users', perm: 'users.view', section: 'main', mobile: true },
  { key: 'drops', label: 'Drops', icon: 'zap', perm: 'drops.view', section: 'main', mobile: true },
  { key: 'moderation', label: 'Moderation', icon: 'shield', perm: 'moderation.view', section: 'content', mobile: true },
  { key: 'anon', label: 'Anonymous', icon: 'eye-off', perm: 'anon.view', section: 'content', mobile: false },
  { key: 'safety', label: 'Safety', icon: 'alert-triangle', perm: 'safety.view', section: 'content', mobile: false },
  { key: 'chat', label: 'Chat', icon: 'message-square', perm: 'chat.view', section: 'content', mobile: false },
  { key: 'chains', label: 'Drop Chains', icon: 'link', perm: 'chains.view', section: 'content', mobile: false },
  { key: 'around', label: 'Around You', icon: 'map-pin', perm: 'regions.view', section: 'insights', mobile: false },
  { key: 'discovery', label: 'Discovery', icon: 'compass', perm: 'discovery.view', section: 'insights', mobile: false },
  { key: 'analytics', label: 'Analytics', icon: 'bar-chart-2', perm: 'analytics.view', section: 'insights', mobile: true },
  { key: 'notifications', label: 'Notifications', icon: 'bell', perm: 'notifications.manage', section: 'system', mobile: false },
  { key: 'settings', label: 'Settings', icon: 'settings', perm: 'settings.manage', section: 'system', mobile: false },
  { key: 'flags', label: 'Feature Flags', icon: 'flag', perm: 'flags.manage', section: 'system', mobile: false },
  { key: 'audit', label: 'Audit Log', icon: 'file-text', perm: 'audit.view', section: 'system', mobile: false },
  { key: 'admins', label: 'Admins', icon: 'user-check', perm: 'admins.manage', section: 'system', mobile: false },
  { key: 'payments', label: 'GenZ+ Payments', icon: 'credit-card', perm: 'payments.view', section: 'system', mobile: false },
];

export function canAccess(perms: string[], role: string, module: AdminModule): boolean {
  if (role === 'super_admin') return true;
  return perms.includes(module.perm) || perms.includes('*');
}

export function accessibleModules(perms: string[], role: string): AdminModule[] {
  return MODULES.filter((m) => canAccess(perms, role, m));
}
