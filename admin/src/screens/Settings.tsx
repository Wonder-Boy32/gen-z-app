import { useState } from 'react';
import { api, SettingRow } from '../lib/api';
import { Page, Card, Spinner, Empty, useLoad, useToast, Switch } from '../components/UI';

export default function Settings() {
  const { toast } = useToast();
  const l = useLoad(() => api.settings(), []);
  const [editing, setEditing] = useState<SettingRow | null>(null);
  const [draft, setDraft] = useState('');

  const save = async () => {
    if (!editing) return;
    let parsed: unknown = draft;
    if (typeof editing.value === 'boolean') parsed = draft === 'true';
    else if (typeof editing.value === 'number') parsed = Number(draft);
    else if (Array.isArray(editing.value)) {
      try { parsed = JSON.parse(draft); } catch { toast('Invalid JSON list', 'error'); return; }
    }
    try {
      await api.settingSet(editing.key, parsed);
      toast(`"${editing.key}" saved`);
      setEditing(null);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  const toggleBool = async (s: SettingRow) => {
    try {
      await api.settingSet(s.key, s.value === true ? false : true);
      toast(`"${s.label ?? s.key}" updated`);
      l.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  if (l.loading) return <Spinner />;
  if (!l.data) return <Empty text="No settings." />;

  const groups: Record<string, SettingRow[]> = {};
  l.data.settings.forEach((s) => {
    (groups[s.category] = groups[s.category] ?? []).push(s);
  });

  const openEditor = (s: SettingRow) => {
    setEditing(s);
    setDraft(Array.isArray(s.value) ? JSON.stringify(s.value) : String(s.value));
  };

  return (
    <Page
      title="Platform Settings"
      sub="Dynamically configurable — no code changes. Only safe-to-change settings are exposed; infrastructure settings are protected server-side."
    >
      {Object.entries(groups).map(([cat, items]) => (
        <div key={cat} className="sec-block">
          <div className="sec-title" style={{ textTransform: 'capitalize' }}>{cat}</div>
          <Card>
            {items.map((s: SettingRow) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(30,42,71,0.5)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{s.label ?? s.key}</div>
                  {s.description && <div className="muted" style={{ fontSize: 12 }}>{s.description}</div>}
                  <div className="mono muted" style={{ fontSize: 11 }}>{s.key}</div>
                </div>
                {typeof s.value === 'boolean' ? (
                  <Switch on={s.value === true} onChange={() => toggleBool(s)} />
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="mono" style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {Array.isArray(s.value) ? `[${s.value.length} items]` : String(s.value)}
                    </span>
                    <button className="btn sm" onClick={() => openEditor(s)}>Edit</button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        </div>
      ))}

      {editing && (
        <div className="modal-overlay" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit {editing.label ?? editing.key}</h3>
            <div className="field">
              <label>Value {Array.isArray(editing.value) ? '(JSON array)' : ''}</label>
              <textarea className="input" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
