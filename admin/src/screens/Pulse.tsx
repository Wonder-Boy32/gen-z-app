import { api } from '../lib/api';
import { Page, Stat, Card, Spinner, Empty, useLoad, fmtTime } from '../components/UI';

export default function Pulse() {
  const p = useLoad(() => api.pulse(), []);

  if (p.loading) return <Spinner />;
  if (!p.data) return <Empty text="No data." />;

  const d = p.data;

  return (
    <Page
      title="48H Pulse"
      sub="The temporary-content ecosystem — every Drop still lives exactly 48 hours. This section only monitors."
    >
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <Stat label="Active Drops" value={d.active_drops} tone="accent" />
        <Stat label="🔥 Rising Drops" value={d.rising_drops} tone="red" />
        <Stat label="🆕 New Drops" value={d.new_drops} tone="green" />
        <Stat label="⏳ Expiring < 6h" value={d.expiring_6h} tone="accent" />
        <Stat label="🚨 Expiring < 1h" value={d.expiring_1h} tone="red" />
        <Stat label="💨 Expired Today" value={d.expired_today} />
        <Stat label="Total Drop Views" value={d.total_views} tone="violet" />
        <Stat label="Total Interactions" value={d.total_interactions} tone="green" />
      </div>

      <Card title="Top rising drops (real engagement, last 24h)">
        {d.top_rising.length === 0 ? (
          <Empty text="No rising drops right now." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Creator</th>
                  <th>Caption</th>
                  <th>Views</th>
                  <th>Likes</th>
                  <th>Comments</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {d.top_rising.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 700 }}>@{r.creator}</td>
                    <td className="muted" style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.caption ?? '—'}</td>
                    <td>{r.views.toLocaleString()}</td>
                    <td>{r.likes_count.toLocaleString()}</td>
                    <td>{r.comments_count.toLocaleString()}</td>
                    <td className="mono time">{r.id.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="sec-block">
        <Card title="Why admin can't touch the timer">
          <p className="muted">
            The 48-hour rule is enforced at the database level: <span className="mono">posts.expires_at</span> is
            immutable (trigger <span className="mono">lock_drop_timestamps</span>), and no admin function in the
            control center reads, extends, resets or restarts a Drop timer. Removing a Drop hides it (soft flag);
            restoring it never resurrects it past its original expiry. Create → 48h → expire → disappear, always.
          </p>
        </Card>
      </div>
    </Page>
  );
}
