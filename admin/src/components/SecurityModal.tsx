import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';
import { useToast, Spinner } from './UI';

// Build a standard otpauth:// URI from the raw TOTP secret. This is what
// authenticator apps actually need — no dependency on the server's uri.
function buildTotpUri(secret: string, email: string): string {
  const issuer = 'Gen Z Admin';
  const label = `${issuer}:${email}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}`;
}

export default function SecurityModal({ mfaEnabled, email, onClose, onChanged }: {
  mfaEnabled: boolean;
  email: string;
  onClose: () => void;
  onChanged: (enabled: boolean) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const enable = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw new Error(error.message);
      const totp = data.totp;
      setFactorId(data.id);
      setSecret(totp.secret);
      // prefer the server URI, fall back to building it from the secret
      setTotpUri(totp.uri && totp.uri.length > 10 ? totp.uri : buildTotpUri(totp.secret, email));
      setEnrolling(true);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!factorId) return;
    setBusy(true);
    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) throw new Error(challenge.error.message);
      const res = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() });
      if (res.error) throw new Error(res.error.message);
      await api.mfaStatus(true);
      onChanged(true);
      toast('2FA enabled 🎉');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      for (const f of data?.all ?? []) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      await api.mfaStatus(false);
      onChanged(false);
      toast('2FA disabled');
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Account Security</h3>

        {mfaEnabled && !enrolling ? (
          <>
            <p className="muted" style={{ marginBottom: 14 }}>
              Two-factor authentication is <b style={{ color: 'var(--green)' }}>enabled</b>. Every sign-in now
              requires a 6-digit code from your authenticator app.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn danger" disabled={busy} onClick={disable}>
                {busy ? '…' : 'Disable 2FA'}
              </button>
            </div>
          </>
        ) : enrolling ? (
          <>
            <p className="muted" style={{ marginBottom: 10 }}>
              Scan this QR with your authenticator app, then enter the 6-digit code it shows.
            </p>
            {totpUri ? (
              <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 12px' }}>
                <div style={{ background: '#ffffff', padding: 12, borderRadius: 14 }}>
                  <QRCodeSVG value={totpUri} size={200} fgColor="#0d1426" bgColor="#ffffff" level="M" />
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', justifyContent: 'center', margin: '10px 0' }}>
                <Spinner />
              </div>
            )}

            <div className="qr-secret">
              <b style={{ color: 'var(--text)' }}>Can't scan? Manual setup:</b>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                Open your authenticator → <b style={{ color: 'var(--text)' }}>Enter setup key</b> → type or paste:
              </div>
              <div style={{ marginTop: 6, wordBreak: 'break-all', color: 'var(--accent)' }}>{secret}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                Type: <b style={{ color: 'var(--text)' }}>TOTP</b> · Account: <b style={{ color: 'var(--text)' }}>Gen Z Admin</b>
              </div>
            </div>

            <div className="field" style={{ marginTop: 14 }}>
              <label>6-digit code from the app</label>
              <input className="input" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="000000" />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={busy || code.length < 6} onClick={verify}>
                {busy ? 'Verifying…' : 'Verify & enable'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 16 }}>
              2FA is currently <b>off</b>. Enabling it protects this admin account with a time-based one-time
              password on top of your password.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn primary" disabled={busy} onClick={enable}>
                {busy ? <Spinner /> : 'Enable 2FA'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
