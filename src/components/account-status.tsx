'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

export function AccountStatus() {
  const pathname = usePathname();
  const router = useRouter();
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/me', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => setAuthenticated(data?.authenticated === true))
      .catch(() => { if (!controller.signal.aborted) setAuthenticated(false); });
    return () => controller.abort();
  }, [pathname]);
  async function logout() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) { setError('로그아웃에 실패했어요. 다시 시도해 주세요.'); return; }
      setAuthenticated(false); router.replace('/'); router.refresh();
    } catch { setError('인터넷 연결을 확인해 주세요.'); }
    finally { setBusy(false); }
  }
  return authenticated ? <div className="account-control"><button className="header-login header-logout" type="button" onClick={logout} disabled={busy}>{busy ? '처리 중…' : '로그아웃'}</button>{error ? <p className="account-error" role="alert">{error}</p> : null}</div> : <Link className="header-login" href="/login">로그인 <span aria-hidden="true">↗</span></Link>;
}
