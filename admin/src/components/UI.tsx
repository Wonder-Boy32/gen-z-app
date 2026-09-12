import React, { createContext, useCallback, useContext, useState } from 'react';
import Icon from './Icon';

// ---------- toast ----------
type Toast = { id: number; msg: string; kind?: 'error' };
const ToastCtx = createContext<{ toast: (msg: string, kind?: 'error') => void }>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, kind?: 'error') => {
    const id = Date.now() + Math.random();
    setItems((p) => [...p, { id, msg, kind }]);
    setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.kind === 'error' ? ' error' : ''}`}>{t.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- primitives ----------
export function Spinner() { return <div className="spinner" />; }

export function Stat({ label, value, tone, suffix }: { label: string; value: React.ReactNode; tone?: 'accent' | 'green' | 'red' | 'violet'; suffix?: string }) {
  return (
    <div className="stat">
      <div className="lbl">{label}</div>
      <div className={`val${tone ? ` ${tone}` : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
        {suffix ? <span className="muted" style={{ fontSize: 12 }}> {suffix}</span> : null}
      </div>
    </div>
  );
}

export function Badge({ text, tone }: { text: string; tone: string }) {
  return <span className={`badge ${tone}`}>{text}</span>;
}

export function statusTone(s: string): string {
  const t = s.toLowerCase();
  if (t === 'active' || t === 'resolved' || t === 'sent' || t === 'enabled' || t === 'low') return 'active';
  if (t === 'restricted' || t === 'medium') return 'restricted';
  if (t === 'suspended' || t === 'scheduled' || t === 'beta' || t === 'high' || t === 'open') return 'suspended';
  if (t === 'banned' || t === 'critical' || t === 'cancelled') return 'banned';
  if (t === 'dismissed' || t === 'disabled' || t === 'draft') return 'dismissed';
  return 'medium';
}

export function Pill({ value }: { value: string }) {
  return <Badge text={value} tone={statusTone(value)} />;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function Avatar({ name, url, size = 32 }: { name?: string | null; url?: string | null; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {url ? <img src={url} alt="" /> : (name ?? '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on}>
      <span className="knob" />
    </button>
  );
}

export function Card({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card${className ? ` ${className}` : ''}`}>
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={wide ? { maxWidth: 560 } : undefined} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }: {
  title: string; message: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 18 }}>{message}</p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className={`btn${danger ? ' danger' : ' primary'}`}
          onClick={() => { onConfirm(); onClose(); }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ReasonPrompt({ title, message, confirmLabel, danger, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string; danger?: boolean;
  onConfirm: (reason: string) => void; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 12 }}>{message}</p>
      <div className="field">
        <label>Reason (recorded in the audit log)</label>
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why?" autoFocus />
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button
          className={`btn${danger ? ' danger' : ' primary'}`}
          disabled={!reason.trim()}
          onClick={() => { onConfirm(reason.trim()); onClose(); }}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function FilterChips({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="filters">
      {options.map((o) => (
        <button key={o} className={`chip${value === o ? ' active' : ''}`} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e: Error) => { setError(e.message); toast(e.message, 'error'); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  React.useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload };
}

export function Page({ title, sub, actions, children }: { title: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-title">{title}</div>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid rgba(30,42,71,0.5)' }}>
      <span className="muted">{k}</span>
      <span style={{ fontWeight: 700, textAlign: 'right' }}>{v}</span>
    </div>
  );
}

export function ActionButtons({ actions }: { actions: { label: string; tone?: 'primary' | 'danger' | 'ghost'; icon?: string; onClick: () => void; disabled?: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {actions.map((a) => (
        <button key={a.label} className={`btn${a.tone ? ` ${a.tone}` : ''} sm`} onClick={a.onClick} disabled={a.disabled}>
          {a.icon && <Icon name={a.icon} size={13} />}
          {a.label}
        </button>
      ))}
    </div>
  );
}
