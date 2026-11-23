import Link from 'next/link';
import { LoginForm } from '@/components/login-form';
import { PageHeading } from '@/components/page-heading';

export default function LoginPage() {
  return <div className="page-width content-page"><div className="split-page"><div><PageHeading eyebrow="HELLO, NEW BEGINNINGS" title="같은 캠퍼스의 우리." description="학교 이메일을 확인하고, 나와 너 사이의 가능성을 만나보세요." /><div className="side-note"><span aria-hidden="true">✦</span><p>프로필을 보는 건 무료.<br />대화의 시작은 서로의 선택으로.</p></div><Link className="text-link" href="/fortune/result">로그인 없이 샘플 둘러보기 →</Link></div><LoginForm /></div></div>;
}
