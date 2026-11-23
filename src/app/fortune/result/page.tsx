import Link from 'next/link';
import { FortuneDemo } from '@/components/fortune-demo';
import { PageHeading } from '@/components/page-heading';
export default function FortuneResultPage() { return <div className="page-width narrow-page content-page"><PageHeading eyebrow="A SMALL PREVIEW" title="나를 알아가는 작은 힌트" description="개발용 고정 샘플로 사주 결과 화면을 미리 둘러보세요." /><FortuneDemo /><div className="below-panel"><Link className="text-link" href="/fortune">내 정보 입력 화면으로 →</Link></div></div>; }
