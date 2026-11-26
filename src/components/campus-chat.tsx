'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/browser';
import { loadMatchResults } from '@/lib/match-results-client';
import { loadChatProfiles, type ChatProfileLookup } from '@/lib/chat-profiles-client';
import type { MatchResultCard, MatchResultsResponse } from '@/contracts/matching';
import { ChatPanel, type ChatSelection } from '../../packages/payment-chat-ui/src/ChatPanel';
import { PaymentDialog } from '../../packages/payment-chat-ui/src/PaymentDialog';
import { Busy } from '../../packages/payment-chat-ui/src/ui';
import { MatchProfilePhoto } from './match-profile-photo';
import { createBrowserClient, PaymentChatClientError } from '../../packages/payment-chat/src/client';
import { createCheckoutFlow, type CheckoutState } from '../../packages/payment-chat/src/checkout-flow';
import { createCheckoutReturnStore } from '../../packages/payment-chat/src/checkout-return-store';
import { createInboxSession, reconcileInboxSelection, type InboxSnapshot, type InboxSession } from '../../packages/payment-chat/src/inbox-session';
import { createSupabaseMessageSource } from '../../packages/payment-chat/src/supabase-message-source';
import type { CampusChatView } from './campus-chat-page';

const safeError = (error: unknown) => error instanceof PaymentChatClientError
  ? error.message : '연결을 확인하고 다시 시도해주세요.';

/** Authenticated composition only: no demo catalog, payment confirmation or fixed actor. */
export function CampusChat({ userId, view, initialRoomId }: { userId: string; view: CampusChatView; initialRoomId?: string }) {
  const router = useRouter();
  const [api] = useState(() => createBrowserClient());
  const [supabase] = useState(() => createClient());
  const messageSource = useMemo(() => createSupabaseMessageSource(supabase), [supabase]);
  const [inbox, setInbox] = useState<InboxSnapshot>({ userId, rooms: [], requests: [], loading: true,
    refreshing: false, error: '', accessDenied: false, requestsComplete: false, roomsComplete: false });
  const sessionRef = useRef<InboxSession | null>(null);
  const [selection, setSelection] = useState<ChatSelection>(null);
  const [matches, setMatches] = useState<MatchResultsResponse | null>(null);
  const [matchError, setMatchError] = useState('');
  const [matchLoading, setMatchLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [profileLookup, setProfileLookup] = useState<ChatProfileLookup & { key: string }>({ key: '', profiles: [], failed: false });
  const [profileReload, setProfileReload] = useState(0);
  const [checkout, setCheckout] = useState<CheckoutState>({ kind: 'idle' });
  const flowRef = useRef<ReturnType<typeof createCheckoutFlow> | null>(null);
  const [selected, setSelected] = useState<MatchResultCard | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const active = useRef(false);
  const [actionError, setActionError] = useState('');
  const [identityChanged, setIdentityChanged] = useState(false);
  const appliedInitialRoom = useRef(false);

  useEffect(() => {
    active.current = true;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user.id === userId) return;
      // Stop subscriptions and pending UI work before changing the rendered account.
      active.current = false;
      sessionRef.current?.dispose();
      flowRef.current?.dispose();
      setIdentityChanged(true);
      router.refresh();
    });
    return () => { active.current = false; data.subscription.unsubscribe(); };
  }, [supabase, userId, router]);

  useEffect(() => {
    const session = createInboxSession({ userId, client: api });
    sessionRef.current = session;
    const stop = session.subscribe(next => {
      setInbox(next);
      setSelection(value => {
        if (!appliedInitialRoom.current && initialRoomId && next.rooms.some(room => room.id === initialRoomId && room.members.includes(userId))) {
          appliedInitialRoom.current = true;
          return { kind: 'room', id: initialRoomId };
        }
        return reconcileInboxSelection(value, userId, next);
      });
    });
    session.start();
    const visible = () => { if (document.visibilityState === 'visible') void session.refresh(true); };
    document.addEventListener('visibilitychange', visible);
    return () => { stop(); session.dispose(); sessionRef.current = null; document.removeEventListener('visibilitychange', visible); };
  }, [userId, api, initialRoomId]);

  useEffect(() => {
    const flow = createCheckoutFlow({ client: api });
    flowRef.current = flow;
    const stop = flow.subscribe(next => {
      setCheckout(next);
      if (view === 'return' && next.kind !== 'idle') setPaymentOpen(true);
    });
    if (view === 'return') {
      const record = createCheckoutReturnStore().read(userId);
      if (record.kind === 'found') {
        void flow.resume(record.orderId);
      }
    }
    return () => { stop(); flow.dispose(); flowRef.current = null; };
  }, [api, userId, view]);

  useEffect(() => {
    if (view !== 'matches') return;
    const controller = new AbortController();
    void loadMatchResults(controller.signal)
      .then(payload => {
        if (!controller.signal.aborted) setMatches(payload);
      }).catch(error => { if (!controller.signal.aborted) { setMatches(null); setMatchError(safeError(error)); } })
      .finally(() => { if (!controller.signal.aborted) setMatchLoading(false); });
    return () => controller.abort();
  }, [view, reload]);

  const publicIds = useMemo(() => [...new Set([
    ...inbox.rooms.flatMap(room => room.members), ...inbox.requests.flatMap(request => [request.from, request.to]),
  ])].filter(id => id !== userId).sort().join(','), [inbox.rooms, inbox.requests, userId]);
  const profileKey = `${publicIds}:${profileReload}`;
  const profiles = publicIds && profileLookup.key === profileKey ? profileLookup.profiles : [];
  const profilesLoading = !!publicIds && profileLookup.key !== profileKey;
  const profilesFailed = !!publicIds && profileLookup.key === profileKey && profileLookup.failed;
  useEffect(() => {
    if (!publicIds) return;
    const controller = new AbortController();
    // Browser RLS enforces visibility and blocking; never use the admin client for these lookups.
    void loadChatProfiles(publicIds.split(','), (batch, signal) => supabase.from('profiles')
      .select('id,nickname,major').in('id', batch).abortSignal(signal), { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setProfileLookup({ key: profileKey, ...result }); })
      .catch(() => { if (!controller.signal.aborted) setProfileLookup({ key: profileKey, profiles: [], failed: true }); });
    return () => controller.abort();
  }, [supabase, publicIds, profileKey]);

  const action = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current || !active.current) return;
    busyRef.current = true; setBusy(true); setActionError('');
    try { await operation(); }
    catch (error) { if (active.current) setActionError(safeError(error)); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }, []);

  function start(result: MatchResultCard) {
    const existingRoom = inbox.rooms.find(room => room.members.includes(userId) && room.members.includes(result.profile.userId));
    if (existingRoom) { router.push(`/chat?room=${encodeURIComponent(existingRoom.id)}`); return; }
    setSelected(result); setActionError(''); setPaymentOpen(true);
    // New checkout is unavailable until Groble is configured. C rolls back failed checkout creation.
    void flowRef.current?.start(result.id);
  }
  function closePayment() { setPaymentOpen(false); flowRef.current?.reset(); setActionError(''); }
  async function requestChat() {
    if (checkout.kind !== 'chat_available') return;
    if (checkout.conversationId) { router.push(`/chat?room=${encodeURIComponent(checkout.conversationId)}`); return; }
    const orderId = checkout.orderId;
    if (!orderId) return;
    await action(async () => {
      await api.requestChat(orderId);
      if (!active.current) return;
      createCheckoutReturnStore().forget(userId, orderId);
      closePayment(); router.push('/requests');
    });
  }
  async function accept(id: string) {
    await action(async () => {
      const room = await api.acceptChat(id);
      if (!active.current) return;
      await sessionRef.current?.refresh(true);
      if (active.current) router.push(`/chat?room=${encodeURIComponent(room.conversationId)}`);
    });
  }
  async function reject(id: string) {
    await action(async () => {
      await api.rejectChat(id);
      if (active.current) await sessionRef.current?.refresh(true);
    });
  }
  function recheck() {
    if ('orderId' in checkout && checkout.orderId) void flowRef.current?.resume(checkout.orderId);
  }
  if (identityChanged) return <div className="page-width content-page" role="status">로그인 상태가 변경됐어요. 화면을 다시 확인하고 있어요.</div>;
  const title = view === 'matches' ? '새로운 사이를 만나보세요' : view === 'return' ? '결제 상태 확인' : view === 'requests' ? '받고 보낸 대화 요청' : '우리의 이야기가 쌓이는 곳';
  return <div className="payment-chat-experience"><div className="campus-chat-content">
    <header className="campus-chat-heading"><p className="eyebrow">OUR NEXT CHAPTER</p><h1>{title}</h1>
      <p>프로필은 무료로 확인하고, 선택한 상대에게 500원으로 대화를 요청해요. 상대가 수락하면 채팅이 열려요.</p>
      <nav aria-label="소개와 대화"><Link href="/matches">무료 추천</Link><Link href="/requests">대화 요청</Link><Link href="/chat">내 대화</Link><Link href="/profile">내 프로필</Link></nav>
    </header>
    {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
    {(view === 'requests' || view === 'chat') && profilesLoading ? <p role="status">대화 상대 정보를 확인하고 있어요.</p> : null}
    {(view === 'requests' || view === 'chat') && profilesFailed ? <div role="status"><p>일부 상대의 이름·학과 정보를 불러오지 못했어요. 대화 기능은 계속 이용할 수 있어요.</p>
      <button className="secondary" onClick={() => setProfileReload(value => value + 1)}>상대 정보 다시 불러오기</button></div> : null}
    {view === 'matches' ? <section aria-label="무료 추천 프로필">
      <p className="campus-payment-status">새 결제는 연결 준비 중이에요. 이미 열린 대화와 받은 요청은 추가 결제 없이 이용할 수 있어요.</p>
      {matchLoading ? <Busy text="추천을 불러오고 있어요" /> : matchError ? <div role="alert"><p>{matchError}</p><button className="secondary" onClick={() => { setMatchLoading(true); setMatchError(''); setReload(value => value + 1); }}>다시 불러오기</button></div> : null}
      {!matchLoading && matches?.status === 'fortune_required' ? <div className="campus-empty"><h2>저장된 사주 결과가 필요해요</h2><p>사주 결과 저장 연결이 완료되면 추천을 시작할 수 있어요.</p><Link href="/fortune">나의 사주 확인</Link></div> : null}
      {!matchLoading && matches?.status === 'profile_required' ? <div className="campus-empty"><h2>내 프로필을 먼저 공개해주세요</h2><Link href="/profile">프로필 등록·수정</Link></div> : null}
      {!matchLoading && matches?.status === 'no_candidates' ? <p>아직 추천할 상대가 없어요. 후보가 생기면 다시 확인해주세요.</p> : null}
      {!matchLoading && matches?.status === 'ready' ? <><p>무료 추천 {matches.results.length}명</p><div className="campus-profile-grid">{matches.results.map(result => <article className="campus-profile" key={result.id}>
        <MatchProfilePhoto nickname={result.profile.nickname} photoUrl={result.profile.photoUrl} /><h2>{result.profile.nickname}</h2><p>{result.profile.major ?? '학과 비공개'}</p><p>{result.profile.bio}</p>
        <div className="tags">{result.profile.interests.map(interest => <span key={interest}>{interest}</span>)}</div>
        <button className="primary" onClick={() => start(result)}>{inbox.rooms.some(room => room.members.includes(result.profile.userId)) ? '대화 이어가기 · 무료' : '대화 권한 확인 · 500원'}</button>
      </article>)}</div></> : null}
    </section> : view === 'return' ? <div className="campus-empty"><p>결제창의 성공 표시 대신 서버에 저장된 주문 상태를 확인해요. 이 브라우저에 저장된 주문이 없다면 추천 화면에서 기존 주문을 확인해주세요.</p><Link href="/matches">무료 추천으로 돌아가기</Link></div> :
      <ChatPanel currentUserId={userId} profiles={profiles} api={api} rooms={inbox.rooms} requests={inbox.requests}
        messageSource={messageSource} selection={selection} listLoading={inbox.loading} listError={inbox.error}
        listHasMore={!inbox.requestsComplete || !inbox.roomsComplete} onReload={() => { void sessionRef.current?.refresh(true); }}
        onSelect={setSelection} onAccept={accept} onReject={reject} busy={busy} />}
    {paymentOpen ? <PaymentDialog profile={selected?.profile ?? { userId: '', nickname: '결제한 상대', major: null }} state={checkout}
      busy={busy} actionError={actionError} onClose={closePayment} onRequest={() => { void requestChat(); }} onRecheck={recheck}
      onRetry={() => { if ('orderId' in checkout && checkout.orderId) recheck(); else if (selected) void flowRef.current?.start(selected.id); }}
      paymentAction={{ kind: 'checkout', onCheckout: () => setActionError('결제 연결을 준비하고 있어요. 지금은 결제창으로 이동할 수 없어요.') }} /> : null}
  </div></div>;
}
