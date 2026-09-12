import { useState } from 'react';
import { api, UserRow, UserDetail } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Avatar, Badge, Pill, fmtTime, FilterChips, ReasonPrompt, ConfirmModal, Meta, ActionButtons, Switch } from '../components/UI';
import Icon from '../components/Icon';

const STATUSES = ['all', 'active', 'restricted', 'suspended', 'banned'];

export default function Users({ param, go }: { param: string | null; go: (r: string, p?: string | null) => void }) {
  if (param) return <UserDetailView userId={param} go={go} />;
  return <UserList go={go} />;
}

function UserList({ go }: { go: (r: string, p?: string | null) => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const { toast } = useToast();
  const l = useLoad(() => api.userList(search || undefined, status === 'all' ? undefined : status), [search, status]);

  return (
    <Page
      title="Users"
      sub="Search, review and manage accounts. Every action is recorded."
      actions={
        <div className="row-inputs" style={{ minWidth: 220 }}>
          <input className="input" placeholder="Search username / ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      }
    >
      <FilterChips options={STATUSES} value={status} onChange={setStatus} />
      {l.loading ? <Spinner /> : !l.data || l.data.users.length === 0 ? (
        <Empty text="No users match." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th></th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Followers</th>
                  <th>Following</th>
                  <th>Active Drops</th>
                  <th>Open Reports</th>
                  <th>Joined</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {l.data.users.map((u: UserRow) => (
                  <tr key={u.id} className="row-click" onClick={() => go('users', u.id)}>
                    <td><Avatar name={u.username} url={u.avatar_url} size={30} /></td>
                    <td>
                      <div style={{ fontWeight: 700 }}>@{u.username} {u.verified && <Badge text="VERIFIED" tone="verified" />}</div>
                      <div className="muted mono" style={{ fontSize: 11 }}>{u.id.slice(0, 8)}</div>
                    </td>
                    <td><Pill value={u.account_status} /></td>
                    <td>{u.followers.toLocaleString()}</td>
                    <td>{u.following.toLocaleString()}</td>
                    <td>{u.active_drops}</td>
                    <td>{u.open_reports > 0 ? <span style={{ color: 'var(--red)', fontWeight: 800 }}>{u.open_reports}</span> : 0}</td>
                    <td className="time">{fmtTime(u.created_at)}</td>
                    <td className="time">{fmtTime(u.last_seen_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Page>
  );
}

function UserDetailView({ userId, go }: { userId: string; go: (r: string, p?: string | null) => void }) {
  const { toast } = useToast();
  const d = useLoad(() => api.userDetail(userId), [userId]);
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [banConfirm, setBanConfirm] = useState(false);

  if (d.loading) return <Spinner />;
  if (!d.data?.user) return <Empty text="User not found." />;
  const u: UserRow = d.data.user;
  const det: UserDetail = d.data;

  const setStatus = async (status: string, reason: string) => {
    try {
      await api.userSetStatus(userId, status, reason);
      toast(`Account set to ${status}`);
      d.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const toggleVerified = async () => {
    try {
      await api.userSetVerified(userId, !u.verified, 'Toggled from admin console');
      toast(u.verified ? 'Verification removed' : 'Account verified');
      d.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  const toggleAnon = async () => {
    try {
      await api.userSetAnon(userId, !u.anon_disabled, 'Toggled from admin console');
      toast(u.anon_disabled ? 'Anonymous messaging enabled' : 'Anonymous messaging disabled');
      d.reload();
    } catch (e: any) { toast(e.message, 'error'); }
  };

  return (
    <Page
      title={`@${u.username}`}
      sub={`Account created ${fmtTime(u.created_at)} · last seen ${fmtTime(u.last_seen_at)}`}
      actions={<button className="btn ghost sm" onClick={() => go('users')}><Icon name="arrow" size={13} /> Back</button>}
    >
      <div className="grid-2">
        <Card title="Account">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <Avatar name={u.username} url={u.avatar_url} size={52} />
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>@{u.username} {u.verified && <Badge text="VERIFIED" tone="verified" />}</div>
              <div className="muted">{u.display_name ?? '—'} · {u.location_region ?? 'no region'}</div>
            </div>
          </div>
          <Meta k="Status" v={<Pill value={u.account_status} />} />
          <Meta k="Anonymous messaging" v={u.anon_disabled ? 'Disabled' : 'Enabled'} />
          <Meta k="Followers" v={u.followers.toLocaleString()} />
          <Meta k="Following" v={u.following.toLocaleString()} />
          <Meta k="Active drops" v={u.active_drops} />
          <Meta k="Open reports" v={u.open_reports} />
          <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn sm" onClick={() => setReasonFor('restricted')}>Restrict</button>
            <button className="btn sm" onClick={() => setReasonFor('suspended')}>Suspend</button>
            <button className="btn sm danger" onClick={() => setBanConfirm(true)}>Ban</button>
            {u.account_status !== 'active' && (
              <button className="btn sm primary" onClick={() => setStatus('active', 'Unbanned from admin console')}>Restore (active)</button>
            )}
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: 12 }}>Verified:</span>
            <Switch on={u.verified} onChange={toggleVerified} />
            <span className="muted" style={{ fontSize: 12, marginLeft: 12 }}>Anonymous messaging:</span>
            <Switch on={!u.anon_disabled} onChange={toggleAnon} />
          </div>
        </Card>

        <Card title="Moderation history">
          {det.history.length === 0 ? (
            <Empty text="No moderation history." />
          ) : (
            det.history.map((h, i) => (
              <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,42,71,0.5)' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{h.action.replace(/_/g, ' ')}</div>
                <div className="muted" style={{ fontSize: 12 }}>{h.admin_email ?? 'system'} · {fmtTime(h.created_at)}</div>
                {h.reason && <div className="muted" style={{ fontSize: 12 }}>“{h.reason}”</div>}
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="sec-block">
        <Card title={`Drops (${det.drops.length})`}>
          {det.drops.length === 0 ? (
            <Empty text="No drops." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Type</th><th>Caption</th><th>Views</th><th>Likes</th><th>Comments</th><th>Created</th><th>Expires</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {det.drops.map((p: any) => (
                    <tr key={p.id}>
                      <td>{p.media_type ?? (p.content ? 'text' : 'media')}</td>
                      <td className="muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.caption ?? p.content ?? '—'}</td>
                      <td>{p.views ?? 0}</td>
                      <td>{p.likes_count}</td>
                      <td>{p.comments_count}</td>
                      <td className="time">{fmtTime(p.created_at)}</td>
                      <td className="time">{fmtTime(p.expires_at)}</td>
                      <td>{p.removed_at ? <Badge text="REMOVED" tone="banned" /> : new Date(p.expires_at) > new Date() ? <Badge text="LIVE" tone="active" /> : <Badge text="EXPIRED" tone="dismissed" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="sec-block">
        <Card title={`Reports (${det.reports.length})`}>
          {det.reports.length === 0 ? (
            <Empty text="No reports." />
          ) : (
            det.reports.map((r: any) => (
              <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(30,42,71,0.5)', display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{r.reason}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{fmtTime(r.created_at)}</div>
                </div>
                <Pill value={r.status} />
              </div>
            ))
          )}
        </Card>
      </div>

      {reasonFor && (
        <ReasonPrompt
          title={`${reasonFor[0].toUpperCase()}${reasonFor.slice(1)} account`}
          message={`Set @${u.username} to ${reasonFor}.`}
          confirmLabel={reasonFor}
          danger={reasonFor === 'banned'}
          onConfirm={(reason) => setStatus(reasonFor, reason)}
          onClose={() => setReasonFor(null)}
        />
      )}
      {banConfirm && (
        <ConfirmModal
          title="Ban account"
          message={`Permanently ban @${u.username}? They lose posting + messaging. Moderation records are kept.`}
          confirmLabel="Ban"
          danger
          onConfirm={() => setStatus('banned', 'Banned from admin console')}
          onClose={() => setBanConfirm(false)}
        />
      )}
    </Page>
  );
}
