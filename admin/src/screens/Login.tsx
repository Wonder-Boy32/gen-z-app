import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/UI';
import Icon from '../components/Icon';

export default function Login({ onAuthed }: { onAuthed: (who: any) => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const finish = async () => {
    const who = await api.whoami();
    onAuthed(who);
  };

  const checkMfa = async () => {
    try {
      const res = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      const aal = res.data;
      if (!aal) return;
      if (aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        const factors = aal.currentLevel === 'aal1' ? (await supabase.auth.mfa.listFactors()).data?.all ?? [] : [];
        const totp = factors.find((f: any) => f.factorType === 'totp');
        if (totp) setFactorId(totp.id);
        return;
      }
      await finish();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const doLogin = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(error.message);
      await checkMfa();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async () => {
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    try {
      const challenge = await supabase.auth.mfa.challenge({ factorId });
      if (challenge.error) throw new Error(challenge.error.message);
      const verify = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code: code.trim() });
      if (verify.error) throw new Error(verify.error.message);
      await finish();
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-title">GEN Z <span>ADMIN</span></div>
        <div className="login-sub">Secure platform control center</div>

        {err && <div className="login-err">{err}</div>}

        {factorId ? (
          <>
            <div className="field">
              <label>Two-factor authentication code</label>
              <input
                className="input"
                inputMode="numeric"
                autoFocus
                placeholder="6-digit code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doVerify()}
              />
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || code.length < 6} onClick={doVerify}>
              {busy ? 'Verifying…' : 'Verify'}
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>Admin email</label>
              <input className="input" type="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" />
            </div>
            <div className="field">
              <label>Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doLogin()} placeholder="••••••••" />
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !email || !password} onClick={doLogin}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="qr-secret" style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="lock" size={14} color="#64708c" />
              <span style={{ fontFamily: 'inherit', fontSize: 12 }}>Protected by server-side role checks, rate-limited auth & optional 2FA</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
