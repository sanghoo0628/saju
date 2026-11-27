import type { InboxSnapshot } from './inbox-session.ts';

export type RecommendationAction =
  | { kind: 'navigate'; label: string; href: string; recheckPermission?: true }
  | { kind: 'checkout'; label: string }
  | { kind: 'disabled'; label: string };

/** Presentation/navigation only. The authenticated server still decides entitlement and payment. */
export function recommendationAction(userId: string, peerId: string, inbox: InboxSnapshot): RecommendationAction {
  if (inbox.userId !== userId || inbox.accessDenied || userId === peerId)
    return { kind: 'disabled', label: '로그인·대화 상태 확인 필요' };
  const room = inbox.rooms.find(value => value.members.includes(userId) && value.members.includes(peerId));
  if (room) return { kind: 'navigate', label: '대화 이어가기 · 무료', href: `/chat?room=${encodeURIComponent(room.id)}` };
  const requests = inbox.requests.filter(value =>
    (value.from === userId && value.to === peerId) || (value.from === peerId && value.to === userId));
  const request = requests.find(value => value.status === 'pending' && value.to === userId)
    ?? requests.find(value => value.status === 'pending')
    ?? requests.find(value => value.status === 'accepted')
    ?? requests[0];
  if (request) return { kind: 'navigate',
    label: request.status === 'pending'
      ? request.to === userId ? '받은 대화 요청 확인 · 무료' : '수락 대기 중 · 요청 확인'
      : request.status === 'accepted' ? '수락된 대화 요청 확인' : '대화 요청 결과 확인',
    href: `/requests?request=${encodeURIComponent(request.id)}`,
    ...(request.from === userId && request.status === 'pending' && !inbox.loading && !inbox.error
      && inbox.requestsComplete && inbox.roomsComplete ? { recheckPermission: true as const } : {}) };
  if (inbox.loading) return { kind: 'disabled', label: '대화 상태 확인 중' };
  if (inbox.error) return { kind: 'disabled', label: '대화 상태 다시 확인 필요' };
  if (!inbox.requestsComplete || !inbox.roomsComplete)
    return { kind: 'navigate', label: '대화 목록에서 상태 확인', href: '/requests' };
  return { kind: 'checkout', label: '대화 권한 확인 · 500원' };
}
