import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { supabase } from './lib/supabase';
import { api, AdminAlert, AlertSummary, ApiError, Whoami } from './lib/api';
import { accessibleModules, AdminModule, MODULES } from './lib/perms';
import { ToastProvider, useToast, Spinner, fmtTime } from './components/UI';
import Icon from './components/Icon';
import Login from './screens/Login';
import SecurityModal from './components/SecurityModal';

import Overview from './screens/Overview';
import Pulse from './screens/Pulse';
import Users from './screens/Users';
import Drops from './screens/Drops';
import Moderation from './screens/Moderation';
import Anonymous from './screens/Anonymous';
import Safety from './screens/Safety';
import Chat from './screens/Chat';
import Chains from './screens/Chains';
import AroundYou from './screens/AroundYou';
import Discovery from './screens/Discovery';
import Analytics from './screens/Analytics';
import Notifications from './screens/Notifications';
import Settings from './screens/Settings';
import Flags from './screens/Flags';
import Audit from './screens/Audit';
import Admins from './screens/Admins';
import Payments from './screens/Payments';
import Verification from './screens/Verification';

const SCREENS: Record<string, ComponentType<any>> = {
  overview: Overview, pulse: Pulse, users: Users, drops: Drops, moderation: Moderation,
  anon: Anonymous, safety: Safety, chat: Chat, chains: Chains, around: AroundYou,
  discovery: Discovery, analytics: Analytics, notifications: Notifications,
  settings: Settings, flags: Flags, audit: Audit, admins: Admins, payments: Payments,
  verification: Verification,
};

function Shell() {
  const [who, setWho] = useState<Whoami | null>(null);
  const [route, setRoute] = useState('overview');
  const [param, setParam] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [boot, setBoot] = useState(true);
  const [alerts, setAlerts] = useState<AlertSummary | null>(null);
  const [alertRows, setAlertRows] = useState<AdminAlert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const { toast } = useToast();

  // Poll what is waiting on a human.
  //
  // Polling, not Realtime, deliberately: this console is a sparse dashboard
  // where a 30s delay costs nothing, while a websocket per open tab is not
  // free. This is the piece that makes a newly submitted verification request
  // visible without the admin already being on that screen.
  useEffect(() => {
    if (!who) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await api.alertSummary();
        if (!cancelled) setAlerts(s);
      } catch {
        // A failed poll must never disturb the console — keep the last count.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [who]);

  const toggleAlerts = async () => {
    if (alertsOpen) {
      setAlertsOpen(false);
      return;
    }
    setAlertsOpen(true);
    try {
      setAlertRows(await api.alertList());
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const ackAlert = async (id: string) => {
    try {
      await api.alertAck(id);
      setAlertRows((rows) => rows.filter((r) => r.id !== id));
      setAlerts((s) => (s ? { ...s, unresolved: Math.max(0, s.unresolved - 1) } : s));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  // Which nav item carries which outstanding count.
  const badgeFor = (key: string): number => {
    if (!alerts) return 0;
    if (key === 'verification') return alerts.verification;
    if (key === 'payments') return alerts.payments;
    if (key === 'moderation') return alerts.reports;
    return 0;
  };

  const bootSession = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) { setBoot(false); return; }
      try {
        const who = await api.whoami();
        setWho(who);
      } catch (e: any) {
        // signed in but not an admin → kill the session
        await supabase.auth.signOut();
        toast(e.message === 'not_an_admin' ? 'This account is not authorized to access the admin center.' : e.message, 'error');
      }
    } catch {
      // ignore — login screen will surface
    } finally {
      setBoot(false);
    }
  }, [toast]);

  useEffect(() => { bootSession(); }, [bootSession]);

  const signOut = async () => {
    await supabase.auth.signOut();
    setWho(null);
    setRoute('overview');
    setParam(null);
  };

  if (boot) {
    return (
      <div className="login-wrap">
        <Spinner />
      </div>
    );
  }

  if (!who) {
    return <Login onAuthed={setWho} />;
  }

  const mods = accessibleModules(who.permissions ?? [], who.role);
  const go = (key: string, p?: string | null) => { setRoute(key); setParam(p ?? null); setMoreOpen(false); };
  const current = mods.find((m) => m.key === route) ?? mods[0];
  const Screen = SCREENS[current.key] ?? Overview;
  const mainMods = mods.filter((m) => m.mobile);
  const moreMods = mods.filter((m) => !m.mobile);

  return (
    <div className="layout">
      {/* desktop sidebar */}
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">GZ</div>
          <div className="logo-text">GEN Z <span>ADMIN</span></div>
        </div>
        {(['main', 'content', 'insights', 'system'] as const).map((section) => {
          const items = mods.filter((m) => m.section === section);
          if (!items.length) return null;
          return (
            <div key={section} className="nav-group">
              <div className="nav-group-label">{section === 'main' ? 'Overview' : section}</div>
              {items.map((m) => (
                <NavBtn
                  key={m.key}
                  m={m}
                  active={route === m.key}
                  count={badgeFor(m.key)}
                  onClick={() => go(m.key)}
                />
              ))}
            </div>
          );
        })}
        <div className="sidebar-footer">
          <button
            className="signout-btn"
            style={{ marginBottom: 6 }}
            onClick={() => void toggleAlerts()}
          >
            {alerts && alerts.unresolved > 0
              ? `🔔 Needs attention (${alerts.unresolved})`
              : '🔔 Nothing waiting'}
          </button>
          <div className="admin-chip">
            <b>{who.email}</b>
            <span className="role">{who.role.replace('_', ' ')} · {who.mfa_enabled ? '2FA on' : '2FA off'}</span>
          </div>
          <button className="signout-btn" style={{ marginBottom: 6 }} onClick={() => setSecurityOpen(true)}>
            {who.mfa_enabled ? '✅ Security' : '🔐 Enable 2FA'}
          </button>
          <button className="signout-btn" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      {/* mobile top bar */}
      <div className="topbar">
        <div className="t-title">GEN Z <span>ADMIN</span></div>
        <button className="btn ghost sm" onClick={signOut}>
          <Icon name="log-out" size={15} /> Out
        </button>
      </div>

      <main className="main">
        <Screen route={route} param={param} go={go} who={who} />
      </main>

      {securityOpen && (
        <SecurityModal
          mfaEnabled={who.mfa_enabled}
          email={who.email}
          onClose={() => setSecurityOpen(false)}
          onChanged={(enabled) => setWho((w) => (w ? { ...w, mfa_enabled: enabled } : w))}
        />
      )}

      {/* mobile bottom nav */}
      <nav className="mobile-nav">
        <div className="mobile-nav-row">
          {mainMods.slice(0, 4).map((m) => (
            <button key={m.key} className={`mobile-nav-item${route === m.key ? ' active' : ''}`} onClick={() => go(m.key)}>
              <Icon name={m.icon} size={20} />
              {m.label}
            </button>
          ))}
          {moreMods.length > 0 && (
            <button className={`mobile-nav-item${moreOpen ? ' active' : ''}`} onClick={() => setMoreOpen((v) => !v)}>
              <Icon name="more-h" size={20} />
              More
            </button>
          )}
        </div>
      </nav>

      {/* mobile more sheet */}
      {moreOpen && (
        <div className="mobile-more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="mobile-more-sheet" onClick={(e) => e.stopPropagation()}>
            {mainMods.slice(4).map((m) => (
              <NavBtn key={m.key} m={m} active={route === m.key} onClick={() => go(m.key)} />
            ))}
            {moreMods.map((m) => (
              <NavBtn key={m.key} m={m} active={route === m.key} onClick={() => go(m.key)} />
            ))}
            <div className="divider" />
            <button className="btn danger" style={{ width: '100%', justifyContent: 'center' }} onClick={signOut}>
              <Icon name="log-out" size={15} /> Sign out ({who.email})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function NavBtn({
  m,
  active,
  onClick,
  count = 0,
}: {
  m: AdminModule;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button className={`nav-item${active ? ' active' : ''}`} onClick={onClick}>
      <Icon name={m.icon} size={16} />
      <span style={{ flex: 1, textAlign: 'left' }}>{m.label}</span>
      {/* Inline styling rather than a class: the tones available to `Badge` are
          severity/status names, and a wrong one renders unstyled. */}
      {count > 0 && (
        <span
          style={{
            background: 'var(--accent, #FFB02E)',
            color: '#1a1206',
            borderRadius: 999,
            padding: '1px 7px',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
