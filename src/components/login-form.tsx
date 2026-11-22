'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [step, setStep] = useState<'email' | 'token'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch(step === 'email' ? '/api/auth/login' : '/api/auth/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(step === 'email' ? { email } : { email, token }),
      });
      const data = await response.json();
      if (!response.ok) { setError(data.error?.message ?? '인증을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.'); return; }
      if (step === 'email') { setStep('token'); setMessage('이메일로 받은 6자리 인증번호를 입력해 주세요.'); }
      else { router.replace('/fortune'); router.refresh(); }
    } catch { setError('서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  return <form className="form-panel" onSubmit={submit}>
    <span className="pill">학교 이메일 인증</span>
    <h2>반가워요, 우리 시작해 볼까요?</h2>
    <p className="form-description">학교 이메일로 인증번호를 받아 가입하거나 로그인해요.</p>
    <div className="field"><label htmlFor="email">학교 이메일</label><input id="email" name="email" type="email" autoComplete="email" placeholder="학교 이메일 주소를 입력해 주세요" value={email} onChange={(event) => setEmail(event.target.value)} required readOnly={step === 'token'} maxLength={254} /><span className="field-hint">서비스에서 확인한 학교의 이메일만 이용할 수 있어요.</span></div>
    {step === 'token' ? <div className="field"><label htmlFor="token">인증번호</label><input id="token" name="token" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} minLength={6} placeholder="6자리 숫자" value={token} onChange={(event) => setToken(event.target.value.replace(/\D/g, ''))} required /></div> : null}
    {message ? <p className="feedback success" role="status">{message}</p> : null}
    {error ? <p className="feedback error" role="alert">{error}</p> : null}
    <button className="button primary full-width" disabled={busy} type="submit">{busy ? '확인하고 있어요…' : step === 'email' ? '인증번호 받기' : '인증하고 시작하기'}<span aria-hidden="true">→</span></button>
    {step === 'token' ? <button className="plain-button" type="button" disabled={busy} onClick={() => { setStep('email'); setToken(''); setError(''); setMessage(''); }}>이메일 변경 또는 인증번호 다시 받기</button> : null}
    <p className="microcopy">현재 개발 미리보기입니다. 인증 서비스와 허용 학교 설정이 완료되기 전에는 로그인할 수 없어요.</p>
  </form>;
}
