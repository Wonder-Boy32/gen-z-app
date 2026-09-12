import { api } from '../lib/api';
import { Page, Stat, Card, Spinner, Empty, useLoad } from '../components/UI';
import { TimeChart, BarSeries, SparkArea } from '../components/Charts';

export default function Overview() {
  const ov = useLoad(() => api.statsOverview(), []);
  const series = useLoad(() => api.analyticsSeries(14), []);
  const snap = useLoad(() => api.analyticsSnapshot(), []);

  if (ov.loading || series.loading || snap.loading) return <Spinner />;
  if (!ov.data || !series.data || !snap.data) return <Empty text="No data available." />;

  const s = ov.data;
  const pts = series.data.series;

  return (
    <Page title="Platform Overview" sub="Real-time pulse of the entire platform">
      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <Stat label="Total Users" value={s.total_users} />
        <Stat label="Active Users (24h)" value={s.active_users} tone="green" />
        <Stat label="Active Drops" value={s.active_drops} tone="accent" />
        <Stat label="Drops Today" value={s.drops_today} />
        <Stat label="Expiring Soon" value={s.expiring_soon} tone="red" />
        <Stat label="Messages Today" value={s.messages_today} />
        <Stat label="Anonymous Msgs" value={s.anon_today} tone="violet" />
        <Stat label="Pending Reports" value={s.pending_reports} tone={s.pending_reports > 0 ? 'red' : 'green'} />
      </div>

      <div className="grid-2">
        <Card title="Daily Active Users (14 days)">
          <SparkArea data={pts} x="day" y="dau" />
        </Card>
        <Card title="New registrations">
          <SparkArea data={pts} x="day" y="new_users" color="#8b7bff" />
        </Card>
      </div>

      <div className="divider" />

      <div className="grid-2">
        <Card title="Drops created vs expired">
          <BarSeries data={pts} x="day" bars={[{ key: 'drops_created', color: '#ff9d1f', name: 'Created' }, { key: 'drops_expired', color: '#64708c', name: 'Expired' }]} />
        </Card>
        <Card title="Engagement">
          <BarSeries data={pts} x="day" bars={[{ key: 'likes', color: '#ff5c7c', name: 'Likes' }, { key: 'comments', color: '#5b8cff', name: 'Comments' }, { key: 'reposts', color: '#34d399', name: 'Reposts' }]} />
        </Card>
      </div>

      <div className="divider" />

      <Card title="Retention & reach">
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          <Stat label="WAU" value={snap.data.wau} tone="accent" />
          <Stat label="MAU" value={snap.data.mau} tone="accent" />
          <Stat label="7-Day Retention" value={snap.data.retention_7d} suffix="%" tone="green" />
          <Stat label="Total Views" value={snap.data.total_drops_viewed} />
          <Stat label="Total Likes" value={snap.data.total_likes} tone="red" />
          <Stat label="Total Comments" value={snap.data.total_comments} />
          <Stat label="Total Reposts" value={snap.data.total_reposts} tone="green" />
          <Stat label="Total Saves" value={snap.data.total_saves} />
          <Stat label="Chat Messages" value={snap.data.total_messages} />
          <Stat label="Anonymous Msgs" value={snap.data.total_anon_messages} tone="violet" />
          <Stat label="Bans" value={snap.data.total_bans} tone="red" />
          <Stat label="Suspensions" value={snap.data.total_suspensions} tone="accent" />
        </div>
      </Card>
    </Page>
  );
}
