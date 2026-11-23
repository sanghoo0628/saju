import Link from 'next/link';
import { PageHeading } from './page-heading';

export function IntegrationPending({ title, description, detail }: { title: string; description: string; detail: string }) {
  return <div className="page-width content-page"><PageHeading eyebrow="OUR NEXT CHAPTER" title={title} description={description} /><section className="empty-panel"><span className="empty-symbol" aria-hidden="true">✳</span><span className="pill">연결 준비 중</span><h2>조금만 기다려 주세요</h2><p>{detail}</p><div className="button-row"><Link className="button primary" href="/fortune/result">사주 샘플 둘러보기 <span aria-hidden="true">→</span></Link><Link className="text-link" href="/">홈으로 돌아가기</Link></div></section></div>;
}
