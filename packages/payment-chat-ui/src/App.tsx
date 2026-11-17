"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createBrowserClient,
  PaymentChatClientError,
} from "../../payment-chat/src/client.ts";
import { createCheckoutFlow } from "../../payment-chat/src/checkout-flow.ts";
import type { CheckoutState } from "../../payment-chat/src/checkout-flow.ts";
import type {
  ChatMessage,
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import type { ChatSelection } from "./ChatPanel.tsx";
import { PaymentDialog } from "./PaymentDialog.tsx";
import { Avatar, Icon, Modal } from "./ui.tsx";
import { MY_ID, MY_SCORE, profiles, signed } from "./catalog.ts";
import type { Profile } from "./catalog.ts";
import type { ChatProfile } from "./types.ts";
import { demoAction } from "./demo-client.ts";
// Demo mapping stays outside reusable payment/chat components.
const chatProfiles: ChatProfile[] = profiles.map((p) => ({
  userId: p.id,
  nickname: p.name,
  major: p.major,
  tone: p.tone,
}));

const api = createBrowserClient();
type Nav = "discover" | "chat";

export default function App() {
  const [nav, setNav] = useState<Nav>("discover");
  const [detail, setDetail] = useState<Profile | null>(null);
  const [payment, setPayment] = useState<Profile | null>(null);
  const [guide, setGuide] = useState(false);
  const [requests, setRequests] = useState<ChatRequestResponse[]>([]);
  const [rooms, setRooms] = useState<ConversationResponse[]>([]);
  const [selection, setSelection] = useState<ChatSelection>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const listController = useRef<AbortController | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState>({ kind: "idle" });
  const flow = useRef<ReturnType<typeof createCheckoutFlow> | null>(null);
  const actionRef = useRef(false);
  const paymentGeneration = useRef(0);
  function navigate(next: Nav) {
    setNav(next);
    setActionError("");
    window.scrollTo({ top: 0, behavior: "auto" });
  }
  const refresh = useCallback(async () => {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setListLoading(true);
    setListError("");
    try {
      const [nextRequests, nextRooms] = await Promise.all([
        api.requests(undefined, controller.signal),
        api.conversations(undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setRequests(nextRequests);
      setRooms(nextRooms);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (
        error instanceof PaymentChatClientError &&
        [401, 403].includes(error.status)
      ) {
        setRequests([]);
        setRooms([]);
        setSelection(null);
      }
      setListError(
        error instanceof PaymentChatClientError && error.status === 401
          ? "로그인이 만료됐어요. 다시 로그인한 뒤 확인해주세요."
          : "대화 목록을 불러오지 못했어요. 연결을 확인하고 다시 시도해주세요.",
      );
    } finally {
      if (!controller.signal.aborted) setListLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => listController.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const instance = createCheckoutFlow({
      client: api,
      intervalMs: 350,
      maxAttempts: 4,
      timeoutMs: 5000,
    });
    flow.current = instance;
    const unsubscribe = instance.subscribe(setCheckout);
    return () => {
      unsubscribe();
      instance.dispose();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  const incoming = requests.filter(
    (r) => r.to === MY_ID && r.status === "pending",
  );
  const labelFor = (profile: Profile) => {
    if (rooms.some((room) => room.members.includes(profile.id)))
      return "대화 이어가기";
    if (incoming.some((r) => r.from === profile.id))
      return "받은 대화 요청 보기";
    if (
      requests.some(
        (r) =>
          r.from === MY_ID && r.to === profile.id && r.status === "pending",
      )
    )
      return "보낸 요청 확인하기";
    return "대화 시작 · 500원";
  };
  function connect(profile: Profile) {
    paymentGeneration.current++;
    setActionError("");
    setDetail(null);
    const room = rooms.find((item) => item.members.includes(profile.id));
    const request = requests.find(
      (item) =>
        (item.from === profile.id || item.to === profile.id) &&
        item.status === "pending",
    );
    if (room || request) {
      navigate("chat");
      setSelection(
        room
          ? { kind: "room", id: room.id }
          : { kind: "request", id: request!.id },
      );
      return;
    }
    setPayment(profile);
    void flow.current?.start(profile.matchId);
  }
  async function action(work: () => Promise<void>) {
    if (actionRef.current) return;
    actionRef.current = true;
    const generation = paymentGeneration.current;
    setBusy(true);
    setActionError("");
    try {
      await work();
    } catch (error) {
      if (generation !== paymentGeneration.current) return;
      setActionError(
        error instanceof PaymentChatClientError
          ? error.message
          : "요청을 확인하지 못했어요. 연결을 확인한 뒤 다시 시도해주세요.",
      );
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  async function confirm(
    mode: "success" | "delay" | "refund_pending" | "cancelled",
  ) {
    if (checkout.kind !== "payment_required") return;
    const orderId = checkout.orderId;
    const token = paymentGeneration.current;
    await action(async () => {
      await demoAction("complete-payment", { orderId, mode });
      if (token === paymentGeneration.current)
        await flow.current?.resume(orderId);
    });
  }
  async function requestChat() {
    if (checkout.kind !== "chat_available") return;
    const token = paymentGeneration.current;
    await action(async () => {
      if (checkout.conversationId) {
        setSelection({ kind: "room", id: checkout.conversationId });
      } else if (checkout.orderId) {
        const invitation = await api.requestChat(checkout.orderId);
        await refresh();
        if (token !== paymentGeneration.current) return;
        setSelection({ kind: "request", id: invitation.id });
      }
      if (token === paymentGeneration.current) {
        setPayment(null);
        navigate("chat");
      }
    });
  }
  async function recheck() {
    if (!("orderId" in checkout) || !checkout.orderId) return;
    const orderId = checkout.orderId;
    await action(async () => {
      await flow.current?.resume(orderId);
    });
  }
  async function finishDelayedDemo() {
    if (checkout.kind !== "confirmation_pending") return;
    const orderId = checkout.orderId;
    const token = paymentGeneration.current;
    await action(async () => {
      await demoAction("complete-payment", { orderId, mode: "success" });
      if (token === paymentGeneration.current)
        await flow.current?.resume(orderId);
    });
  }
  async function retryCheckout() {
    if (checkout.kind !== "error") return;
    if (checkout.orderId) {
      await recheck();
      return;
    }
    if (checkout.matchResultId)
      await flow.current?.start(checkout.matchResultId);
  }
  const accept = async (id: string) =>
    action(async () => {
      const result = await api.acceptChat(id);
      await refresh();
      setSelection({ kind: "room", id: result.conversationId });
    });
  const reject = async (id: string) =>
    action(async () => {
      await api.rejectChat(id);
      await refresh();
      setSelection(null);
      setNotice("대화 요청을 정중히 거절했어요.");
    });
  const simulateAccept = async (id: string) =>
    action(async () => {
      const result = await demoAction<{ conversationId: string }>(
        "accept-request",
        { requestId: id },
      );
      await refresh();
      setSelection({ kind: "room", id: result.conversationId });
    });
  const simulateReply = useCallback(
    (id: string) => demoAction<ChatMessage>("reply", { conversationId: id }),
    [],
  );
  async function resetDemo() {
    await action(async () => {
      await demoAction("reset");
      flow.current?.reset();
      await refresh();
      setPayment(null);
      setDetail(null);
      setSelection(null);
      navigate("discover");
      setNotice("데모를 처음 상태로 되돌렸어요.");
    });
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("discover");
          }}
          aria-label="홍연 홈"
        >
          <span className="brand-mark">緣</span>
          <span>
            홍연<small>HONGYEON</small>
          </span>
        </a>
        <div className="sidebar-caption">우리 사이의 작은 가능성</div>
        <nav aria-label="주 메뉴">
          <button
            className={`nav-item ${nav === "discover" ? "active" : ""}`}
            onClick={() => navigate("discover")}
          >
            <Icon name="spark" />
            오늘의 인연
            <Icon name="arrow" size={15} />
          </button>
          <button
            className={`nav-item ${nav === "chat" ? "active" : ""}`}
            onClick={() => navigate("chat")}
          >
            <Icon name="chat" />
            나의 대화
            {incoming.length ? (
              <span className="nav-count">{incoming.length}</span>
            ) : null}
          </button>
          <button className="nav-item" onClick={() => setGuide(true)}>
            <Icon name="info" />
            홍연 이용 안내
          </button>
        </nav>
        <div className="sidebar-quote">
          <span>“</span>
          <p>
            서로 다른 우리가
            <br />
            만나서, 조금 더 가까이.
          </p>
          <div className="quote-line" />
        </div>
        <div className="sidebar-bottom">
          <div className="my-profile">
            <span className="my-avatar">나</span>
            <div>
              <strong>
                나의 인연수 <b>{signed(MY_SCORE)}</b>
              </strong>
              <span>문과 · 데모 프로필</span>
            </div>
          </div>
          <div className="sidebar-footer">
            <span>고려대 학생을 위한 비공식 데모</span>
            <button
              onClick={() => {
                void resetDemo();
              }}
              disabled={busy}
              aria-label="데모 초기화"
            >
              <Icon name="refresh" size={15} />
            </button>
          </div>
        </div>
      </aside>
      <main className={`main-content ${nav === "chat" ? "chat-page" : ""}`}>
        <header className="topbar">
          <div className="mobile-brand">
            <span>緣</span>홍연
          </div>
          <span className="breadcrumb">
            캠퍼스<span>/</span>
            {nav === "discover" ? "오늘의 인연" : "나의 대화"}
          </span>
          <div className="topbar-right">
            <span className="demo-badge">
              <span />
              화면 체험
            </span>
            <span className="campus-label">KOREA UNIVERSITY</span>
          </div>
        </header>
        {actionError && !payment ? (
          <div className="action-feedback" role="alert">
            <p>{actionError}</p>
            <button className="secondary" onClick={() => setActionError("")}>
              닫기
            </button>
          </div>
        ) : null}
        {nav === "discover" ? (
          <>
            <section className="hero">
              <div className="hero-copy">
                <div className="eyebrow">
                  <span className="short-rule" />A CONNECTION THAT ADDS UP
                </div>
                <h1>
                  우연보다 조금 더,
                  <br />
                  <span>가까운 인연.</span>
                </h1>
                <p>
                  문과의 <b>+</b>와 이과의 <b>−</b>가 만나는 곳.
                  <br />
                  서로를 더했을 때 가장 가까운 세 사람을 만나보세요.
                </p>
                <div className="hero-note">
                  <span>나의 인연수</span>
                  <strong>{signed(MY_SCORE)}</strong>
                  <span className="hero-divider" />
                  <span>문과의 플러스</span>
                </div>
              </div>
              <div className="orbit-art" aria-hidden="true">
                <div className="orbit-ring ring-one" />
                <div className="orbit-ring ring-two" />
                <div className="orbit-center">緣</div>
                <span className="orbit-plus">+</span>
                <span className="orbit-minus">−</span>
                <span className="orbit-label">DIFFERENT, TOGETHER.</span>
                <span className="orbit-star">✳</span>
              </div>
            </section>
            <section
              className="recommendations"
              aria-labelledby="recommend-title"
            >
              <div className="section-heading">
                <div>
                  <span className="eyebrow">YOUR THREE CONNECTIONS</span>
                  <h2 id="recommend-title">
                    오늘, 당신과 가까운 세 사람
                    <span className="count-badge">03</span>
                  </h2>
                </div>
                <span className="free-profile">
                  <Icon name="lock" size={14} />
                  프로필 열람은 무료예요
                </span>
              </div>
              <div className="profile-grid">
                {profiles.map((profile, index) => (
                  <article className="profile-card" key={profile.id}>
                    <button
                      className={`profile-art ${profile.tone}`}
                      onClick={() => setDetail(profile)}
                      aria-label={`${profile.name} 프로필 보기`}
                    >
                      <Avatar name={profile.name} tone={profile.tone} />
                      <span className="profile-number">0{index + 1}</span>
                      <span className="art-caption">A LITTLE POSSIBILITY</span>
                      {index === 0 ? (
                        <span className="closest-tag">
                          <Icon name="spark" size={12} />
                          가장 가까운 인연
                        </span>
                      ) : null}
                    </button>
                    <div className="profile-body">
                      <div className="profile-name">
                        <button onClick={() => setDetail(profile)}>
                          <h3>{profile.name}</h3>
                          <span>이과</span>
                        </button>
                        <span className="profile-score">
                          {signed(profile.score)}
                        </span>
                      </div>
                      <p className="profile-major">
                        {profile.major} · {profile.year}
                      </p>
                      <p className="profile-bio">{profile.bio}</p>
                      <div className="tags">
                        {profile.interests.map((tag) => (
                          <span key={tag}>{tag}</span>
                        ))}
                      </div>
                      <div className="match-explainer">
                        <span>우리의 합</span>
                        <strong>{signed(MY_SCORE + profile.score)}</strong>
                        <span>0에 가까울수록 잘 맞아요</span>
                      </div>
                      <button
                        className="card-cta"
                        onClick={() => setDetail(profile)}
                      >
                        프로필 자세히 보기
                        <Icon name="arrow" size={17} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <section className="how-it-works">
              <div className="how-title">
                <Icon name="leaf" size={22} />
                <strong>
                  인연은 천천히,
                  <br />
                  시작은 가볍게.
                </strong>
              </div>
              <div>
                <span>01</span>
                <p>
                  세 사람의 프로필을
                  <br />
                  <strong>무료로 살펴보고</strong>
                </p>
              </div>
              <div>
                <span>02</span>
                <p>
                  마음이 닿는 한 사람에게
                  <br />
                  <strong>500원으로 인사를 건네고</strong>
                </p>
              </div>
              <div>
                <span>03</span>
                <p>
                  상대가 수락하면
                  <br />
                  <strong>둘만의 대화를 시작해요</strong>
                </p>
              </div>
            </section>
            <footer className="page-footer">
              <span>© HONGYEON · 서로 다른 우리가 만나는 곳</span>
              <button onClick={() => setGuide(true)}>
                오락용 매칭 안내
                <Icon name="info" size={13} />
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="chat-page-heading">
              <div>
                <span className="eyebrow">BETWEEN YOU AND ME</span>
                <h1>인연을 대화로.</h1>
              </div>
              <span>수락한 두 사람만 나누는 이야기</span>
            </div>
            <ChatPanel
              currentUserId={MY_ID}
              profiles={chatProfiles}
              demo={{ onAcceptRequest: simulateAccept, onReply: simulateReply }}
              rooms={rooms}
              requests={requests}
              selection={selection}
              listLoading={listLoading}
              listError={listError}
              onReload={() => {
                void refresh();
              }}
              onSelect={(value) => {
                setActionError("");
                setSelection(value);
              }}
              onAccept={accept}
              onReject={reject}
              api={api}
              busy={busy}
            />
          </>
        )}
        <div className="mobile-nav">
          <button
            className={nav === "discover" ? "active" : ""}
            onClick={() => navigate("discover")}
          >
            <Icon name="spark" />
            오늘의 인연
          </button>
          <button
            className={nav === "chat" ? "active" : ""}
            onClick={() => navigate("chat")}
          >
            <Icon name="chat" />
            나의 대화{incoming.length ? <i>{incoming.length}</i> : null}
          </button>
          <button onClick={() => setGuide(true)}>
            <Icon name="info" />
            이용 안내
          </button>
        </div>
      </main>
      {detail ? (
        <Modal
          title={`${detail.name} 프로필`}
          onClose={() => setDetail(null)}
          className="profile-modal"
        >
          <div className={`profile-detail-art ${detail.tone}`}>
            <Avatar name={detail.name} tone={detail.tone} />
            <span className="detail-art-text">SOMEONE LIKE YOU</span>
          </div>
          <div className="detail-content">
            <div className="eyebrow">YOUR CONNECTION</div>
            <h2>
              {detail.name}
              <span>이과</span>
            </h2>
            <p className="profile-major">
              {detail.major} · {detail.year}
            </p>
            <div className="detail-math">
              <span>
                나 <b>{signed(MY_SCORE)}</b>
              </span>
              <span>+</span>
              <span>
                {detail.name} <b>{signed(detail.score)}</b>
              </span>
              <span>=</span>
              <strong>{signed(MY_SCORE + detail.score)}</strong>
            </div>
            <h3>이런 사람이에요</h3>
            <p className="detail-intro">{detail.intro}</p>
            <div className="tags">
              {detail.interests.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            <button className="primary wide" onClick={() => connect(detail)}>
              {labelFor(detail)}
              <Icon name="arrow" size={18} />
            </button>
            <p className="profile-free-note">
              프로필 열람 무료 · 대화 시작은 상대당 한 번만 결제
            </p>
          </div>
        </Modal>
      ) : null}
      {payment ? (
        <PaymentDialog
          key={payment.id}
          profile={chatProfiles.find((p) => p.userId === payment.id)!}
          paymentAction={{
            kind: "demo",
            onConfirm: (mode) => {
              void confirm(mode);
            },
            onFinishDelayedPayment: () => {
              void finishDelayedDemo();
            },
          }}
          state={checkout}
          busy={busy}
          actionError={actionError}
          onRetry={() => {
            void retryCheckout();
          }}
          onClose={() => {
            paymentGeneration.current++;
            setPayment(null);
            flow.current?.reset();
          }}
          onRequest={() => {
            void requestChat();
          }}
          onRecheck={() => {
            void recheck();
          }}
        />
      ) : null}
      {guide ? (
        <Modal
          title="홍연 이용 안내"
          onClose={() => setGuide(false)}
          className="guide-modal"
        >
          <span className="eyebrow">A FEW THINGS TO KNOW</span>
          <h2>우리, 이렇게 만나요.</h2>
          <div className="guide-step">
            <span>01</span>
            <div>
              <h3>프로필은 무료로</h3>
              <p>
                문과는 양수, 이과는 음수의 인연수를 가져요. 두 점수의 합이 0에
                가까운 세 사람을 추천해요.
              </p>
            </div>
          </div>
          <div className="guide-step">
            <span>02</span>
            <div>
              <h3>대화 시작은 상대당 500원</h3>
              <p>
                선택한 한 사람에게 대화 요청을 보낼 수 있어요. 같은 상대와
                대화를 이어갈 때 추가 결제는 없어요.
              </p>
            </div>
          </div>
          <div className="guide-step">
            <span>03</span>
            <div>
              <h3>받은 인사는 무료로</h3>
              <p>
                상대가 수락하면 대화가 시작돼요. 받은 요청 수락과 답장은
                무료예요. 수락이나 답장은 보장되지 않아요.
              </p>
            </div>
          </div>
          <p className="guide-disclaimer">
            인연수는 사주 풀이와 별개인 오락용 매칭 규칙이에요. 이 화면의 인물은
            모두 가상이며, 실제 결제가 발생하지 않는 로컬 데모예요.
          </p>
          <button className="primary wide" onClick={() => setGuide(false)}>
            알겠어요
            <Icon name="check" size={17} />
          </button>
        </Modal>
      ) : null}
      {notice ? (
        <div className="toast" role="status">
          <Icon name="info" size={18} />
          {notice}
          <button onClick={() => setNotice("")} aria-label="알림 닫기">
            <Icon name="close" size={15} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
