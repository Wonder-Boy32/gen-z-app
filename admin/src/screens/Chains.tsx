import { api } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, Badge, fmtTime } from '../components/UI';

export default function Chains() {
  const c = useLoad(() => api.chains(), []);

  return (
    <Page
      title="Drop Chains"
      sub="Reply threads on a root drop. Every member keeps its own 7-day timer — a response never extends the root."
    >
      {c.loading ? <Spinner /> : !c.data || c.data.chains.length === 0 ? (
        <Empty text="No active chains." />
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Chain</th>
                  <th>Creator</th>
                  <th>Root caption</th>
                  <th>Responses</th>
                  <th>Views</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>Reports</th>
                  <th>Root created</th>
                  <th>Root expires</th>
                </tr>
              </thead>
              <tbody>
                {c.data.chains.map((ch: any) => {
                  const live = new Date(ch.expires_at) > new Date();
                  return (
                    <tr key={ch.chain_id}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{ch.chain_id.slice(0, 8)}</td>
                      <td style={{ fontWeight: 700 }}>@{ch.creator}</td>
                      <td className="muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.caption ?? '—'}</td>
                      <td><span style={{ fontWeight: 800, color: 'var(--accent)' }}>{ch.responses}</span></td>
                      <td>{ch.views.toLocaleString()}</td>
                      <td>{ch.likes_count.toLocaleString()}</td>
                      <td>{ch.comments_count.toLocaleString()}</td>
                      <td>{ch.open_reports > 0 ? <Badge text={`${ch.open_reports}`} tone="banned" /> : 0}</td>
                      <td className="time">{fmtTime(ch.created_at)}</td>
                      <td className="time">{live ? fmtTime(ch.expires_at) : <Badge text="EXPIRED" tone="dismissed" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Page>
  );
}
