import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountStatus } from '@/components/account-status';
import './globals.css';

export const metadata: Metadata = {
  title: { default: '사이 — 우연에서 시작하는 우리', template: '%s | 사이' },
  description: '사주를 대화의 계기로, 나와 너 사이의 새로운 시작. 대학생을 위한 소개 서비스 개발 미리보기.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <a className="skip-link" href="#main">본문으로 건너뛰기</a>
        <header className="site-header">
          <Link className="brand" href="/" aria-label="사이 홈">사이<span className="brand-dot" /></Link>
          <nav aria-label="주 메뉴">
            <Link href="/fortune">나의 사주</Link>
            <Link href="/matches">새로운 사이</Link>
            <Link href="/chat">대화</Link>
          </nav>
          <AccountStatus />
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div><Link className="brand footer-brand" href="/">사이<span className="brand-dot" /></Link><p>우연에서 시작하는 우리.</p></div>
          <p>개발 미리보기 · 사주 결과는 오락과 대화의 참고용입니다.<br />실제 소개·결제·채팅 기능은 연결 준비 중입니다.</p>
        </footer>
      </body>
    </html>
  );
}
