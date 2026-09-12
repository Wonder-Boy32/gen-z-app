import { useState } from 'react';
import { api, AdminRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime, Avatar } from '../components/UI';

const ROLES = ['admin', 'moderator', 'support', 'analytics'];

export default function Admins({ who }: { who: any }) {
  const { toast } = useToast();
  const l = useLoad(() => api.admins(), []);
  const [email, setEmail] = useState('');
  const [role, setRoleState] = useState('admin');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api.adminAdd(email.trim(), role);
      toast(`${email.trim()} added as ${role}`);
      setEmail('');
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const setRole = async (a: AdminRow, r: string) => {
    if (a.role === 'super_admin' && who.user_id !== a.user_id) return;
    try {
      await api.adminSetRole(a.user_id, r);
      toast(`Role set to ${r}`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const remove = async (a: AdminRow) => {
    try {
      await api.adminRemove(a.user_id);
      toast(`${a.email} disabled`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page title="Admin Accounts" sub="Manage who can operate the control center. Roles are enforced server-side.">
      <Card title="Add an admin">
        <div className="row-inputs">
          <div className="field">
            <label>Email (must be a registered user)</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="moderator@example.com" />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="input" value={role} onChange={(e) => setRoleState(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>
        <button className="btn primary" onClick={add} disabled={busy || !email.trim()}>
          {busy ? 'Adding…' : 'Add admin'}
        </button>
      </Card>

      <div className="sec-block">
        <Card title="Current admins">
          {l.loading ? <Spinner /> : !l.data || l.data.admins.length === 0 ? (
            <Empty text="No admins." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th></th><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Added</th><th>Last login</th><th></th></tr>
                </thead>
                <tbody>
                  {l.data.admins.map((a: AdminRow) => (
                    <tr key={a.user_id}>
                      <td><Avatar name={a.email} size={30} /></td>
                      <td className="mono" style={{ fontSize: 12 }}>{a.email}</td>
                      <td>
                        {a.role === 'super_admin' ? (
                          <Badge text="SUPER ADMIN" tone="banned" />
                        ) : (
                          <select className="input" style={{ padding: 5, fontSize: 12, width: 130 }} value={a.role} onChange={(e) => setRole(a, e.target.value)}>
                            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        )}
                      </td>
                      <td><Badge text={a.status.toUpperCase()} tone={a.status === 'active' ? 'active' : 'disabled'} /></td>
                      <td>{a.mfa_enabled ? '✅' : '—'}</td>
                      <td className="time">{fmtTime(a.created_at)}</td>
                      <td className="time">{fmtTime(a.last_login_at)}</td>
                      <td>
                        {a.user_id !== who.user_id && a.role !== 'super_admin' && (
                          <button className="btn sm danger" onClick={() => remove(a)}>Disable</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
