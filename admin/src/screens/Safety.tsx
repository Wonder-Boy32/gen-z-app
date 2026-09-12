import { api } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Pill, Avatar } from '../components/UI';

export default function Safety() {
  const { toast } = useToast();
  const s = useLoad(() => api.safety(), []);

  if (s.loading) return <Spinner />;
  if (!s.data) return <Empty text="No safety data." />;

  const d = s.data;
  const sus = d.suspicious_accounts ?? [];
  const heavy = d.anon_heavy_senders ?? [];
  const spam = d.spam_like_users ?? [];

  const quickBan = async (id: string, username: string) => {
    try {
      await api.userSetStatus(id, 'suspended', 'Flagged by safety center');
      toast(`@${username} suspended`);
      s.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const quickDisableAnon = async (id: string, username: string) => {
    try {
      await api.userSetAnon(id, true, 'Flagged by safety center');
      toast(`@${username} anonymous messaging disabled`);
      s.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page
      title="Safety Center"
      sub="Anti-spam & abuse patterns, derived from real activity (reports, blocks, anonymous volume)."
    >
      <div className="grid-2">
        <Card title="Suspicious accounts (≥3 reports or ≥5 blocks)">
          {sus.length === 0 ? <Empty text="None flagged." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th></th><th>User</th><th>Status</th><th>Reports</th><th>Blocks</th><th>Anon sent</th><th></th></tr>
                </thead>
                <tbody>
                  {sus.map((u: any) => (
                    <tr key={u.id}>
                      <td><Avatar name={u.username} size={28} /></td>
                      <td style={{ fontWeight: 700 }}>@{u.username}</td>
                      <td><Pill value={u.account_status} /></td>
                      <td>{u.reports_against}</td>
                      <td>{u.times_blocked}</td>
                      <td>{u.anon_sent}</td>
                      <td><button className="btn sm danger" onClick={() => quickBan(u.id, u.username)}>Suspend</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Anonymous-heavy senders (≥10 sent)">
          {heavy.length === 0 ? <Empty text="None." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th></th><th>User</th><th>Sent</th><th></th></tr>
                </thead>
                <tbody>
                  {heavy.map((u: any) => (
                    <tr key={u.id}>
                      <td><Avatar name={u.username} size={28} /></td>
                      <td style={{ fontWeight: 700 }}>@{u.username}</td>
                      <td>{u.sent}</td>
                      <td><button className="btn sm" onClick={() => quickDisableAnon(u.id, u.username)}>Disable anon</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="sec-block">
        <Card title="Spam-like activity (≥5 anonymous msgs in 24h)">
          {spam.length === 0 ? <Empty text="None in the last 24 hours." /> : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th></th><th>User</th><th>Msgs (24h)</th><th></th></tr>
                </thead>
                <tbody>
                  {spam.map((u: any) => (
                    <tr key={u.id}>
                      <td><Avatar name={u.username} size={28} /></td>
                      <td style={{ fontWeight: 700 }}>@{u.username}</td>
                      <td>{u.msgs}</td>
                      <td><button className="btn sm danger" onClick={() => quickDisableAnon(u.id, u.username)}>Disable anon</button></td>
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
