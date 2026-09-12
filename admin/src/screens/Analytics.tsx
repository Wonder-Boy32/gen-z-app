import { useState } from 'react';
import { api } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, Stat, FilterChips } from '../components/UI';
import { TimeChart, BarSeries } from '../components/Charts';

const RANGES = ['7 Days', '30 Days', '90 Days'];

export default function Analytics() {
  const [days, setDays] = useState(7);
  const series = useLoad(() => api.analyticsSeries(days), [days]);
  const snap = useLoad(() => api.analyticsSnapshot(), []);

  const rangeLabel = (d: number) => (d === 7 ? '7 Days' : d === 30 ? '30 Days' : '90 Days');

  if (series.loading || snap.loading) return <Spinner />;
  if (!series.data || !snap.data) return <Empty text="No analytics data." />;

  const pts = series.data.series;

  return (
    <Page title="Advanced Analytics" sub="Every metric is computed from real backend activity.">
      <FilterChips options={RANGES} value={rangeLabel(days)} onChange={(v) => setDays(v === '7 Days' ? 7 : v === '30 Days' ? 30 : 90)} />

      <div className="grid-2">
        <Card title={`Daily Active Users — ${rangeLabel(days)}`}>
          <TimeChart data={pts} x="day" lines={[{ key: 'dau', color: '#ff9d1f', name: 'DAU' }]} height={240} />
        </Card>
        <Card title="New registrations">
          <BarSeries data={pts} x="day" bars={[{ key: 'new_users', color: '#8b7bff', name: 'New users' }]} />
        </Card>
      </div>

      <div className="divider" />

      <Card title="Content activity">
        <BarSeries
          data={pts}
          x="day"
          height={260}
          bars={[
            { key: 'views', color: '#5b8cff', name: 'Views' },
            { key: 'likes', color: '#ff5c7c', name: 'Likes' },
            { key: 'comments', color: '#34d399', name: 'Comments' },
          ]}
        />
      </Card>

      <div className="divider" />

      <div className="grid-2">
        <Card title="Chat & anonymous activity">
          <BarSeries data={pts} x="day" bars={[{ key: 'messages', color: '#ff9d1f', name: 'Messages' }, { key: 'anon_messages', color: '#a8e6f2', name: 'Anonymous' }]} />
        </Card>
        <Card title="Retention & reach">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))' }}>
            <Stat label="DAU (avg)" value={Math.round(pts.reduce((s, p) => s + p.dau, 0) / Math.max(pts.length, 1))} tone="accent" />
            <Stat label="WAU" value={snap.data.wau} tone="accent" />
            <Stat label="MAU" value={snap.data.mau} tone="accent" />
            <Stat label="Retention 7d" value={snap.data.retention_7d} suffix="%" tone="green" />
            <Stat label="Follows" value={snap.data.total_follows} />
            <Stat label="Conversations" value={snap.data.total_conversations} />
            <Stat label="Bans" value={snap.data.total_bans} tone="red" />
            <Stat label="Suspensions" value={snap.data.total_suspensions} tone="accent" />
          </div>
        </Card>
      </div>
    </Page>
  );
}
