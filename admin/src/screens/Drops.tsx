import { useState } from 'react';
import { api, DropRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime, FilterChips, ReasonPrompt } from '../components/UI';

const FILTERS = ['active', 'expiring', 'reported', 'expired', 'removed', 'all'];

export default function Drops() {
  const [filter, setFilter] = useState('active');
  const [search, setSearch] = useState('');
  const { toast } = useToast();
  const [pending, setPending] = useState<{ drop: DropRow; action: 'remove' | 'restore' } | null>(null);
  const l = useLoad(() => api.dropList(filter, search || undefined), [filter, search]);

  const act = async (drop: DropRow, action: 'remove' | 'restore', reason: string) => {
    try {
      if (action === 'remove') await api.dropRemove(drop.id, reason);
      else await api.dropRestore(drop.id, reason);
      toast(action === 'remove' ? 'Drop removed' : 'Drop restored');
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page
      title="Drops"
      sub="7-day content. Admin can remove or restore — never extend. The timer is untouchable by design."
      actions={
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search creator / caption…" value={search} onChange={(e) => setSearch(e.target.value)} />
      }
    >
      <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
      {l.loading ? <Spinner /> : !l.data || l.data.drops.length === 0 ? (
        <Empty text="No drops in this view." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Type</th>
                  <th>Caption</th>
                  <th>Views</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>Reposts</th>
                  <th>Reports</th>
                  <th>Created</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {l.data.drops.map((d: DropRow) => {
                  const live = !d.removed_at && new Date(d.expires_at) > new Date();
                  return (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 700 }}>@{d.creator}</td>
                      <td className="muted">{d.media_type ?? (d.content ? 'text' : 'media')}</td>
                      <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.caption ?? d.content ?? '—'}</td>
                      <td>{d.views.toLocaleString()}</td>
                      <td>{d.likes_count.toLocaleString()}</td>
                      <td>{d.comments_count.toLocaleString()}</td>
                      <td>{d.reposts.toLocaleString()}</td>
                      <td>{d.open_reports > 0 ? <span style={{ color: 'var(--red)', fontWeight: 800 }}>{d.open_reports}</span> : 0}</td>
                      <td className="time">{fmtTime(d.created_at)}</td>
                      <td className="time">{fmtTime(d.expires_at)}</td>
                      <td>
                        {d.removed_at ? <Badge text="REMOVED" tone="banned" /> : live ? <Badge text="LIVE" tone="active" /> : <Badge text="EXPIRED" tone="dismissed" />}
                      </td>
                      <td>
                        {live && !d.removed_at && (
                          <button className="btn sm danger" onClick={() => setPending({ drop: d, action: 'remove' })}>Remove</button>
                        )}
                        {d.removed_at && (
                          <button className="btn sm primary" onClick={() => setPending({ drop: d, action: 'restore' })}>Restore</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pending && (
        <ReasonPrompt
          title={pending.action === 'remove' ? 'Remove drop' : 'Restore drop'}
          message={pending.action === 'remove'
            ? 'Hide this drop from the platform? The 7-day timer is untouched — restoring later only works until it naturally expires.'
            : 'Bring this drop back? Only works if it has not already expired (7-day rule).'}
          confirmLabel={pending.action}
          danger={pending.action === 'remove'}
          onConfirm={(reason) => act(pending.drop, pending.action, reason)}
          onClose={() => setPending(null)}
        />
      )}
    </Page>
  );
}
