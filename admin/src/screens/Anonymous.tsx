import { useState } from 'react';
import { api, AnonReport } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime, ReasonPrompt } from '../components/UI';

export default function Anonymous() {
  const { toast } = useToast();
  const [pending, setPending] = useState<{ report: AnonReport; action: string } | null>(null);
  const l = useLoad(() => api.anonReports('open'), []);

  const resolve = async (report: AnonReport, action: string, reason: string) => {
    try {
      await api.anonResolve(report.id, action, reason);
      toast(`Report ${action.replace(/_/g, ' ')}`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page
      title="Anonymous Messages"
      sub="Reported anonymous messages. Sender identity is internal (moderation only) — recipients never see it, and no user-facing surface exposes it."
    >
      {l.loading ? <Spinner /> : !l.data || l.data.reports.length === 0 ? (
        <Empty text="No open anonymous reports." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Message</th>
                  <th>Recipient</th>
                  <th>Internal sender</th>
                  <th>Reported at</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {l.data.reports.map((r: AnonReport) => (
                  <tr key={r.id}>
                    <td><Badge text={r.severity.toUpperCase()} tone={r.severity} /></td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{r.content ?? `[${r.message_type} media]`}</div>
                      <div className="muted" style={{ fontSize: 12 }}>{r.reason}{r.note ? ` — “${r.note}”` : ''}</div>
                    </td>
                    <td>@{r.recipient ?? 'unknown'}</td>
                    <td>
                      <span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{r.internal_sender ? `@${r.internal_sender}` : 'deleted'}</span>
                      <span className="muted" style={{ fontSize: 11, display: 'block' }}>moderation-only</span>
                    </td>
                    <td className="time">{fmtTime(r.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setPending({ report: r, action: 'resolve' })}>Resolve</button>
                        <button className="btn sm ghost" onClick={() => setPending({ report: r, action: 'dismiss' })}>Dismiss</button>
                        <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'remove_content' })}>Remove</button>
                        <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'disable_anon' })}>Block sender anon</button>
                        <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'ban_user' })}>Ban sender</button>
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
          message={`Apply "${pending.action.replace(/_/g, ' ')}"?`}
          confirmLabel={pending.action.replace(/_/g, ' ')}
          danger={!['resolve', 'dismiss'].includes(pending.action)}
          onConfirm={(reason) => resolve(pending.report, pending.action, reason)}
          onClose={() => setPending(null)}
        />
      )}
    </Page>
  );
}
