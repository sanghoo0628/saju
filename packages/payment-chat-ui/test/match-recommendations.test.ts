import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { MatchRecommendations } from '../../../src/components/match-recommendations';
import type { InboxSnapshot } from '../../payment-chat/src/inbox-session';
import type { MatchResultsResponse } from '../../../src/contracts/matching';

vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: import('react').ReactNode }) => createElement('a', props, children) }));
const inbox = (extra: Partial<InboxSnapshot> = {}): InboxSnapshot => ({ userId: 'alice', requests: [], rooms: [], loading: false,
  refreshing: false, error: '', accessDenied: false, requestsComplete: true, roomsComplete: true, ...extra });
const ready: MatchResultsResponse = { status: 'ready', results: [{ id: 'match-1', rank: 1,
  profile: { userId: 'bob', nickname: '공개 별명', gender: null, university: null, major: null, bio: '', interests: [], track: 'science', photoUrl: null } }] };
function render(matches = ready, state = inbox()) {
  return renderToStaticMarkup(createElement(MatchRecommendations, { userId: 'alice', matches, loading: false, error: '', inbox: state,
    onReloadMatches: () => {}, onReloadInbox: () => {}, onStartMatch: () => {} }));
}

it('offers matching birth storage even while the fortune provider is unavailable', () => {
  const html = render({ status: 'fortune_required', results: [] });
  expect(html).toContain('href="/fortune"'); expect(html).toContain('양력 생년월일 저장에 동의하면');
  expect(html).not.toContain('사주 결과 저장 연결이 완료되면');
});
it('candidate shortages point to profile and preference settings', () => {
  expect(render({ status: 'no_candidates', results: [] })).toContain('href="/profile"');
});
it('a pending request renders a detail link without a checkout button', () => {
  const html = render(ready, inbox({ requests: [{ id: 'request-1', from: 'alice', to: 'bob', orderId: 'order-1', status: 'pending', createdAt: '2026-11-26T00:00:00Z' }] }));
  expect(html).toContain('href="/requests?request=request-1"');
  expect(html).toContain('수락 대기 중 · 요청 확인'); expect(html).not.toContain('대화 권한 확인 · 500원');
});
it('an existing room renders an accessible free conversation link', () => {
  const html = render(ready, inbox({ rooms: [{ id: 'room-1', members: ['alice', 'bob'], createdAt: '2026-11-26T00:00:00Z' }] }));
  expect(html).toContain('href="/chat?room=room-1"'); expect(html).toContain('대화 이어가기 · 무료');
});
it('initial inbox loading disables the card action rather than starting checkout', () => {
  const html = render(ready, inbox({ loading: true }));
  expect(html).toContain('disabled=""'); expect(html).toContain('대화 상태 확인 중');
});
it('a failed inbox exposes recovery and expired authorization exposes login', () => {
  const offline = render(ready, inbox({ error: '연결을 확인해주세요.' }));
  expect(offline).toContain('role="alert"'); expect(offline).toContain('대화 상태 다시 확인'); expect(offline).toContain('disabled=""');
  const expired = render(ready, inbox({ error: '다시 로그인해주세요.', accessDenied: true }));
  expect(expired).toContain('href="/login"'); expect(expired).toContain('disabled=""');
});
