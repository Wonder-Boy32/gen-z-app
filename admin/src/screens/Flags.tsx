import { api, FlagRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Badge, fmtTime } from '../components/UI';

const STATES = ['enabled', 'disabled', 'beta'];

export default function Flags() {
  const { toast } = useToast();
  const l = useLoad(() => api.flags(), []);

  const set = async (f: FlagRow, state: string) => {
    try {
      await api.flagSet(f.key, state, f.rollout_type, f.rollout_value);
      toast(`${f.key} → ${state}`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <Page
      title="Feature Flags"
      sub="Safe rollout control for current and future features — enabled, disabled, or beta (with optional rollout rules)."
    >
      {l.loading ? <Spinner /> : !l.data || l.data.flags.length === 0 ? (
        <Empty text="No flags." />
      ) : (
        <Card>
          {l.data.flags.map((f: FlagRow) => (
            <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid rgba(30,42,71,0.5)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 140 }}>
                <div style={{ fontWeight: 800, textTransform: 'uppercase', fontSize: 13, letterSpacing: 0.4 }}>{f.key.replace(/_/g, ' ')}</div>
                <div className="muted" style={{ fontSize: 11 }}>rollout: {f.rollout_type}{f.rollout_value ? ` · ${f.rollout_value}` : ''} · updated {fmtTime(f.updated_at)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge text={f.state.toUpperCase()} tone={f.state} />
                {STATES.filter((s) => s !== f.state).map((s) => (
                  <button key={s} className={`btn sm ${s === 'disabled' ? 'ghost' : s === 'beta' ? '' : 'primary'}`} onClick={() => set(f, s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}
