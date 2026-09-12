import { useState } from 'react';
import { api, AuditEntry } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, fmtTime, FilterChips, Badge } from '../components/UI';

const CATS = ['all', 'users', 'drops', 'moderation', 'anon', 'chat', 'safety', 'settings', 'flags', 'notifications', 'admins', 'security'];

export default function Audit() {
  const [cat, setCat] = useState('all');
  const l = useLoad(() => api.audit(cat === 'all' ? undefined : cat), [cat]);

  return (
    <Page title="Audit Log" sub="Every important admin action, permanently recorded.">
      <FilterChips options={CATS} value={cat} onChange={setCat} />
      {l.loading ? <Spinner /> : !l.data || l.data.entries.length === 0 ? (
        <Empty text="No audit entries." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Admin</th>
                  <th>Action</th>
                  <th>Category</th>
                  <th>Target</th>
                  <th>Reason</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {l.data.entries.map((e: AuditEntry, i: number) => (
                  <tr key={i}>
                    <td className="time">{fmtTime(e.created_at)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{e.admin_email ?? 'system'}</td>
                    <td style={{ fontWeight: 700, textTransform: 'capitalize' }}>{e.action.replace(/_/g, ' ')}</td>
                    <td><Badge text={e.category} tone="medium" /></td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{e.target_id ? `${e.target_type ?? ''} ${e.target_id.slice(0, 8)}` : '—'}</td>
                    <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.reason ?? '—'}</td>
                    <td className="mono muted" style={{ fontSize: 11, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.metadata ? JSON.stringify(e.metadata) : '—'}
                    </td>
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
