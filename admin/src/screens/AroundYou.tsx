import { api } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad } from '../components/UI';
import { BarSeries, Donut } from '../components/Charts';

const COLORS = ['#ff9d1f', '#8b7bff', '#34d399', '#ff5c7c', '#5b8cff', '#fce123', '#a8e6f2', '#ff7a00'];

export default function AroundYou() {
  const r = useLoad(() => api.regions(), []);

  if (r.loading) return <Spinner />;
  if (!r.data) return <Empty text="No regional data." />;

  const regions = r.data.regions ?? [];
  const drops = r.data.drop_locations ?? [];
  const donutData = drops.slice(0, 6).map((d: any, i: number) => ({ name: d.location, value: d.drops, color: COLORS[i % COLORS.length] }));
  const barData = regions.slice(0, 10).map((x: any) => ({ name: x.region, users: x.users, active_drops: x.active_drops }));

  return (
    <Page
      title="Around You"
      sub="Privacy-preserving regional aggregates only — never precise user locations."
    >
      <div className="grid-2">
        <Card title="Top regions by users & active drops">
          {barData.length === 0 ? <Empty text="No regions yet." /> : (
            <BarSeries data={barData} x="name" bars={[{ key: 'users', color: '#ff9d1f', name: 'Users' }, { key: 'active_drops', color: '#5b8cff', name: 'Active drops' }]} />
          )}
        </Card>
        <Card title="Drop locations (aggregate)">
          {donutData.length === 0 ? <Empty text="No location-tagged drops." /> : <Donut data={donutData} />}
        </Card>
      </div>

      <div className="sec-block">
        <Card title="Regional table">
          {regions.length === 0 ? (
            <Empty text="No regional data." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Region</th><th>Users</th><th>Active drops</th></tr>
                </thead>
                <tbody>
                  {regions.map((x: any) => (
                    <tr key={x.region}>
                      <td style={{ fontWeight: 700 }}>{x.region}</td>
                      <td>{x.users.toLocaleString()}</td>
                      <td>{x.active_drops.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
