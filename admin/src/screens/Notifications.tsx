import { useState } from 'react';
import { api, NotificationRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime } from '../components/UI';

const AUDIENCES = ['all', 'new_users', 'verified', 'creators', 'country', 'region'];

export default function Notifications() {
  const { toast } = useToast();
  const l = useLoad(() => api.notifications(), []);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [audience, setAudience] = useState('all');
  const [value, setValue] = useState('');
  const [schedule, setSchedule] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim() || !message.trim()) return;
    setBusy(true);
    try {
      await api.notificationCreate(
        title.trim(),
        message.trim(),
        audience,
        ['country', 'region'].includes(audience) && value.trim() ? value.trim() : null,
        schedule || null
      );
      toast('Notification created');
      setTitle(''); setMessage(''); setSchedule('');
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = async (n: NotificationRow) => {
    try {
      await api.notificationSend(n.id);
      toast('Notification sent to audience');
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const cancel = async (n: NotificationRow) => {
    try {
      await api.notificationCancel(n.id);
      toast('Notification cancelled');
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page title="Notifications" sub="Official platform broadcasts only — admins never impersonate users.">
      <Card title="Compose announcement">
        <div className="field">
          <label>Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. New feature: Drop Rooms are here" />
        </div>
        <div className="field">
          <label>Message</label>
          <textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Official message…" />
        </div>
        <div className="row-inputs">
          <div className="field">
            <label>Audience</label>
            <select className="input" value={audience} onChange={(e) => setAudience(e.target.value)}>
              {AUDIENCES.map((a) => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          {['country', 'region'].includes(audience) && (
            <div className="field">
              <label>Region value</label>
              <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Lagos / NG" />
            </div>
          )}
          <div className="field">
            <label>Schedule (optional)</label>
            <input className="input" type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          </div>
        </div>
        <button className="btn primary" onClick={create} disabled={busy || !title.trim() || !message.trim()}>
          {busy ? 'Creating…' : 'Create announcement'}
        </button>
      </Card>

      <div className="sec-block">
        <Card title="Broadcasts">
          {l.loading ? <Spinner /> : !l.data || l.data.notifications.length === 0 ? (
            <Empty text="No broadcasts yet." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Status</th><th>Title</th><th>Audience</th><th>Delivered</th><th>Created</th><th>Sent</th><th></th></tr>
                </thead>
                <tbody>
                  {l.data.notifications.map((n: NotificationRow) => (
                    <tr key={n.id}>
                      <td><Badge text={n.status.toUpperCase()} tone={n.status} /></td>
                      <td>
                        <div style={{ fontWeight: 700 }}>{n.title}</div>
                        <div className="muted" style={{ fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.message}</div>
                      </td>
                      <td className="muted">{n.audience_type}{n.audience_value ? `: ${n.audience_value}` : ''}</td>
                      <td>{n.delivered.toLocaleString()}</td>
                      <td className="time">{fmtTime(n.created_at)}</td>
                      <td className="time">{fmtTime(n.sent_at)}</td>
                      <td>
                        {n.status === 'draft' && <button className="btn sm primary" onClick={() => send(n)}>Send now</button>}
                        {(n.status === 'draft' || n.status === 'scheduled') && (
                          <button className="btn sm ghost" onClick={() => cancel(n)}>Cancel</button>
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
