'use client';

import Link from 'next/link';
import type { MatchResultCard, MatchResultsResponse } from '../contracts/matching';
import type { InboxSnapshot } from '../../packages/payment-chat/src/inbox-session';
import { recommendationAction } from '../../packages/payment-chat/src/recommendation-action';
import { Busy } from '../../packages/payment-chat-ui/src/ui';
import { MatchProfilePhoto } from './match-profile-photo';

export function MatchRecommendations({ userId, matches, loading, error, inbox, onReloadMatches, onReloadInbox, onStartMatch, onCheckPermission }: {
  userId: string;
  matches: MatchResultsResponse | null;
  loading: boolean;
  error: string;
  inbox: InboxSnapshot;
  onReloadMatches: () => void;
  onReloadInbox: () => void;
  onStartMatch: (result: MatchResultCard) => void;
  onCheckPermission: (result: MatchResultCard) => void;
}) {
  return <section aria-label="무료 추천 프로필">
    <p className="campus-payment-status">새 결제는 연결 준비 중이에요. 이미 열린 대화와 받은 요청은 추가 결제 없이 이용할 수 있어요.</p>
    {inbox.error ? <div role="alert"><p>{inbox.error}</p>{inbox.accessDenied
      ? <Link href="/login">다시 로그인</Link>
      : <button className="secondary" onClick={onReloadInbox}>대화 상태 다시 확인</button>}</div> : null}
    {loading ? <Busy text="추천을 불러오고 있어요" /> : error ? <div role="alert"><p>{error}</p><button className="secondary" onClick={onReloadMatches}>다시 불러오기</button></div> : null}
    {!loading && matches?.status === 'fortune_required' ? <div className="campus-empty"><h2>매칭용 생년월일을 먼저 저장해주세요</h2><p>사주 풀이가 준비 중이어도 양력 생년월일 저장에 동의하면 프로필 등록과 무료 추천을 이용할 수 있어요.</p><Link href="/fortune">매칭용 생년월일 저장</Link></div> : null}
    {!loading && matches?.status === 'profile_required' ? <div className="campus-empty"><h2>내 프로필을 먼저 공개해주세요</h2><Link href="/profile">프로필 등록·수정</Link></div> : null}
    {!loading && matches?.status === 'no_candidates' ? <div className="campus-empty"><p>현재 서로의 추천 조건에 맞는 공개 프로필이 없어요. 후보가 생기면 다시 확인해주세요.</p><Link href="/profile">내 프로필·추천 조건 확인</Link></div> : null}
    {!loading && matches?.status === 'ready' ? <><p>무료 추천 {matches.results.length}명</p><div className="campus-profile-grid">{matches.results.map(result => {
      const next = recommendationAction(userId, result.profile.userId, inbox);
      return <article className="campus-profile" key={result.id}>
        <MatchProfilePhoto nickname={result.profile.nickname} photoUrl={result.profile.photoUrl} /><h2>{result.profile.nickname}</h2><p>{result.profile.major ?? '학과 비공개'}</p><p>{result.profile.bio}</p>
        <div className="tags">{result.profile.interests.map(interest => <span key={interest}>{interest}</span>)}</div>
        {next.kind === 'navigate' ? <Link className="button primary" href={next.href}>{next.label}</Link>
          : <button className="primary" disabled={next.kind === 'disabled'} onClick={() => onStartMatch(result)}>{next.label}</button>}
        {next.kind === 'navigate' && next.recheckPermission
          ? <button className="secondary" onClick={() => onCheckPermission(result)}>결제 상태·대화 권한 확인</button> : null}
      </article>;
    })}</div></> : null}
  </section>;
}
