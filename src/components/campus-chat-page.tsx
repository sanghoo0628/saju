import Link from 'next/link';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { ApiError } from '@/lib/http/api';
import { ConfigurationError } from '@/lib/env/schema';
import { CampusChat } from './campus-chat';

export type CampusChatView = 'matches' | 'chat' | 'requests' | 'return';

export async function CampusChatPage({ view, initialRoomId }: { view: CampusChatView; initialRoomId?: string }) {
  let userId: string;
  try { userId = (await requireVerifiedSchoolUser()).user.id; }
  catch (error) {
    const unavailable = error instanceof ConfigurationError || (error instanceof ApiError && error.status === 503);
    if (!(error instanceof ApiError) && !unavailable) throw error;
    return <section className="page-width content-page"><div className="empty-panel">
      <span className="pill">{unavailable ? '연결 준비 중' : '학교 계정 인증'}</span>
      <h1>{unavailable ? '서비스 연결을 준비하고 있어요' : '학교 이메일로 로그인해주세요'}</h1>
      <p>{unavailable ? '로그인 설정이 준비되면 무료 추천과 대화 요청을 이용할 수 있어요.' : '인증된 학교 계정으로 내 추천과 대화를 확인할 수 있어요.'}</p>
      <Link className="button primary" href="/login">로그인으로 이동</Link>
    </div></section>;
  }
  return <CampusChat key={`${userId}:${view}:${initialRoomId ?? ''}`} userId={userId} view={view} initialRoomId={initialRoomId} />;
}
