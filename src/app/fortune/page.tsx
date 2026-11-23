import { PageHeading } from '@/components/page-heading';
import { FortuneForm } from '@/components/fortune-form';
import { getFortunePublicConfiguration } from '@/features/fortune/configured';

export const dynamic = 'force-dynamic';

export default function FortunePage() {
  const configuration = getFortunePublicConfiguration();
  return <div className="page-width narrow-page content-page"><PageHeading eyebrow="GET TO KNOW YOURSELF" title="당신의 이야기를 들려주세요" description="태어난 순간에서 시작하는 작은 호기심. 태어난 시간을 몰라도 괜찮아요." /><FortuneForm configuration={configuration} /></div>;
}
