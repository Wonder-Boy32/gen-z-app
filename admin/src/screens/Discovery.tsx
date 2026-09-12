import { api } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, Avatar } from '../components/UI';

export default function Discovery() {
  const d = useLoad(() => api.discovery(), []);

  if (d.loading) return <Spinner />;
  if (!d.data) return <Empty text="No discovery data." />;

  const trending = d.data.trending_drops ?? [];
  const sounds = d.data.trending_sounds ?? [];
  const creators = d.data.top_creators ?? [];

  return (
    <Page
      title="Discovery"
      sub="Trending based on real engagement only — no fake views, likes or follows, ever."
    >
      <div className="grid-2">
        <Card title="Trending drops (real engagement score)">
          {trending.length === 0 ? <Empty text="None right now." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>#</th><th>Creator</th><th>Caption</th><th>Views</th><th>Likes</th><th>Comments</th></tr>
                </thead>
                <tbody>
                  {trending.map((t: any, i: number) => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 800, color: 'var(--accent)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 700 }}>@{t.creator}</td>
                      <td className="muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.caption ?? '—'}</td>
                      <td>{t.views.toLocaleString()}</td>
                      <td>{t.likes_count.toLocaleString()}</td>
                      <td>{t.comments_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Trending sounds">
          {sounds.length === 0 ? <Empty text="No sounds in use." /> : (
            sounds.map((s: any) => (
              <div key={s.sound} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(30,42,71,0.5)' }}>
                <span style={{ fontWeight: 700 }}>🎵 {s.sound}</span>
                <span className="muted">{s.drops} drops</span>
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="sec-block">
        <Card title="Top creators by followers">
          {creators.length === 0 ? <Empty text="No creators yet." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th></th><th>Creator</th><th>Followers</th><th>Active drops</th></tr>
                </thead>
                <tbody>
                  {creators.map((c: any) => (
                    <tr key={c.id}>
                      <td><Avatar name={c.username} size={30} /></td>
                      <td style={{ fontWeight: 700 }}>@{c.username}</td>
                      <td>{c.followers.toLocaleString()}</td>
                      <td>{c.active_drops}</td>
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
