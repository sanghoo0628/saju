import Link from 'next/link';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { ApiError } from '@/lib/http/api';
import { ConfigurationError } from '@/lib/env/schema';
import { PageHeading } from '@/components/page-heading';
import { ProfileForm } from '@/components/profile-form';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  let userId: string;
  try { userId = (await requireVerifiedSchoolUser()).user.id; }
  catch (error) {
    const unavailable = error instanceof ConfigurationError || (error instanceof ApiError && error.status === 503);
    if (!(error instanceof ApiError) && !unavailable) throw error;
    return <section className="page-width content-page"><div className="empty-panel">
      <span className="pill">{unavailable ? '연결 준비 중' : '학교 계정 인증'}</span>
      <h1>{unavailable ? '서비스 연결을 준비하고 있어요' : '학교 이메일로 로그인해주세요'}</h1>
      <p>{unavailable ? '로그인 설정이 준비되면 프로필을 등록할 수 있어요.' : '인증된 학교 계정으로 내 프로필을 등록할 수 있어요.'}</p>
      <Link className="button primary" href="/login">로그인으로 이동</Link>
    </div></section>;
  }
  return <div className="page-width content-page narrow-page">
    <PageHeading eyebrow="MY PROFILE" title="나를 소개하는 한 페이지" description="공개에 동의하면 점수 합이 0에 가까운 상대에게 무료 추천 카드로 보여요. 생년월일·점수·학교 이메일은 카드에 나오지 않아요." />
    <ProfileForm key={userId} userId={userId} />
  </div>;
}
