import Link from 'next/link';
export default function NotFound() { return <div className="page-width content-page"><section className="empty-panel"><p className="eyebrow">404 · A SMALL DETOUR</p><h1>아직 없는 페이지예요</h1><p>다시 시작할 수 있도록 홈으로 안내할게요.</p><Link className="button primary" href="/">홈으로 돌아가기 <span aria-hidden="true">→</span></Link></section></div>; }
