'use client';
import Link from 'next/link';
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="page-width content-page"><section className="empty-panel" role="alert"><span className="empty-symbol" aria-hidden="true">↻</span><h1>잠시 연결이 어려워요</h1><p>입력한 내용이나 비밀 정보는 오류 화면에 표시하지 않아요.<br />잠시 후 다시 시도해 주세요.</p><div className="button-row"><button className="button primary" onClick={reset}>다시 시도하기</button><Link className="text-link" href="/">홈으로 돌아가기</Link></div></section></div>; }
