import { useState } from 'react';
import { api, ReportRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime, FilterChips, ReasonPrompt, Pill } from '../components/UI';

const SEVS = ['all', 'critical', 'high', 'medium', 'low'];

export default function Moderation() {
  const [sev, setSev] = useState('all');
  const { toast } = useToast();
  const [pending, setPending] = useState<{ report: ReportRow; action: string } | null>(null);
  const l = useLoad(() => api.reportList(sev === 'all' ? undefined : sev, 'open'), [sev]);

  const resolve = async (report: ReportRow, action: string, reason: string) => {
    try {
      await api.reportResolve(report.id, action, reason);
      toast(`Report ${action.replace(/_/g, ' ')}`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page title="Moderation" sub="Reports queue by severity. Every decision is audited.">
      <FilterChips options={SEVS} value={sev} onChange={setSev} />
      {l.loading ? <Spinner /> : !l.data || l.data.reports.length === 0 ? (
        <Empty text="Queue is clear 🎉" />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Reason</th>
                  <th>Reporter</th>
                  <th>Reported</th>
                  <th>Target</th>
                  <th>Reported at</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {l.data.reports.map((r: ReportRow) => (
                  <tr key={r.id}>
                    <td><Badge text={r.severity.toUpperCase()} tone={r.severity} /></td>
                    <td>
                      <div style={{ fontWeight: 700 }}>{r.reason}</div>
                      {r.note && <div className="muted" style={{ fontSize: 12 }}>“{r.note}”</div>}
                    </td>
                    <td>@{r.reporter ?? 'anon'}</td>
                    <td>{r.reported_user ? `@${r.reported_user}` : <span className="muted">—</span>}</td>
                    <td className="muted">
                      {r.post_id ? `Drop ${r.post_id.slice(0, 8)}${r.drop_removed ? ' (removed)' : ''}` : r.comment_id ? 'Comment' : r.reported_user_id ? 'Account' : '—'}
                      {r.drop_caption && <div style={{ fontSize: 11 }}>{r.drop_caption.slice(0, 60)}</div>}
                    </td>
                    <td className="time">{fmtTime(r.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setPending({ report: r, action: 'resolve' })}>Review</button>
                        <button className="btn sm ghost" onClick={() => setPending({ report: r, action: 'dismiss' })}>Dismiss</button>
                        {r.post_id && <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'remove_content' })}>Remove</button>}
                        {r.reported_user_id && <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'suspend_user' })}>Suspend</button>}
                        {r.reported_user_id && <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'ban_user' })}>Ban</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pending && (
        <ReasonPrompt
          title={pending.action.replace(/_/g, ' ')}
          message={`Apply "${pending.action.replace(/_/g, ' ')}" to this report?`}
          confirmLabel={pending.action.replace(/_/g, ' ')}
          danger={!['resolve', 'dismiss'].includes(pending.action)}
          onConfirm={(reason) => resolve(pending.report, pending.action, reason)}
          onClose={() => setPending(null)}
        />
      )}
    </Page>
  );
}
