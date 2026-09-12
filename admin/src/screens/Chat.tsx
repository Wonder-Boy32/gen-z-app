import { useState } from 'react';
import { api, ChatReport } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime, ReasonPrompt } from '../components/UI';

export default function ChatModeration() {
  const { toast } = useToast();
  const [pending, setPending] = useState<{ report: ChatReport; action: string } | null>(null);
  const l = useLoad(() => api.chatReports('open'), []);

  const resolve = async (report: ChatReport, action: string, reason: string) => {
    try {
      await api.chatResolve(report.id, action, reason);
      toast(`Report ${action.replace(/_/g, ' ')}`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page
      title="Chat Moderation"
      sub="Privacy-first: only reported conversations/messages surface here. No bulk message reading."
    >
      {l.loading ? <Spinner /> : !l.data || l.data.reports.length === 0 ? (
        <Empty text="No open chat reports." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Reported message</th>
                  <th>Reporter</th>
                  <th>Reported user</th>
                  <th>Conversation</th>
                  <th>Reported at</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {l.data.reports.map((r: ChatReport) => (
                  <tr key={r.id}>
                    <td><Badge text={r.severity.toUpperCase()} tone={r.severity} /></td>
                    <td>
                      <div style={{ fontWeight: 600, maxWidth: 240 }}>{r.message_content ?? `[${r.message_type ?? 'media'} message]`}</div>
                      {r.message_created_at && <div className="muted" style={{ fontSize: 11 }}>{fmtTime(r.message_created_at)}</div>}
                    </td>
                    <td>@{r.reporter ?? 'unknown'}</td>
                    <td>{r.reported_user ? `@${r.reported_user}` : '—'}</td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{r.conversation_id.slice(0, 8)} · {r.participants}p</td>
                    <td className="time">{fmtTime(r.created_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => setPending({ report: r, action: 'resolve' })}>Resolve</button>
                        <button className="btn sm ghost" onClick={() => setPending({ report: r, action: 'dismiss' })}>Dismiss</button>
                        <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'remove_content' })}>Remove msg</button>
                        {r.reported_user && <button className="btn sm danger" onClick={() => setPending({ report: r, action: 'ban_user' })}>Ban</button>}
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
