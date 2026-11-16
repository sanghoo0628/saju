"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import {
  createBrowserClient,
  PaymentChatClientError,
} from "../../payment-chat/src/client.ts";
import { createMessageTimeline } from "../../payment-chat/src/message-timeline.ts";
import { MY_ID, profiles } from "./catalog.ts";
import { Avatar, Busy, Icon } from "./ui.tsx";

export type ChatSelection = { kind: "room" | "request"; id: string } | null;
type Api = ReturnType<typeof createBrowserClient>;
const time = (value: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));

function Conversation({
  room,
  api,
  onReply,
}: {
  room: ConversationResponse;
  api: Api;
  onReply: (id: string) => Promise<ChatMessage>;
}) {
  const other = profiles.find((p) => room.members.includes(p.id));
  const [timeline] = useState(() => createMessageTimeline(room.id));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const sendingRef = useRef(false);
  const sendController = useRef<AbortController | null>(null);
  const active = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    let inProgress = false;
    async function load() {
      if (inProgress) return;
      inProgress = true;
      try {
        for (let i = 0; i < 10; i++) {
          const token = timeline.nextHistoryPage();
          const page = await api.messages(
            room.id,
            token.afterId,
            controller.signal,
          );
          if (!active.current || controller.signal.aborted) return;
          timeline.appendHistory(page, token);
          setMessages(timeline.snapshot().messages);
          setError("");
          if (page.length < 100) break;
        }
      } catch (err) {
        if (!controller.signal.aborted && active.current) {
          setError("대화를 불러오지 못했어요. 잠시 후 다시 확인할게요.");
          if (
            err instanceof PaymentChatClientError &&
            [401, 403].includes(err.status)
          ) {
            timeline.clear();
            setMessages([]);
          }
        }
      } finally {
        inProgress = false;
        if (active.current) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => {
      void load();
    }, 2500);
    const reconnect = () => {
      if (document.visibilityState === "visible") {
        timeline.restartHistory();
        void load();
      }
    };
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      active.current = false;
      controller.abort();
      sendController.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", reconnect);
      timeline.clear();
    };
  }, [api, room.id, timeline]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length]);
  async function send() {
    const body = draft.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    const controller = (sendController.current = new AbortController());
    try {
      const result = await api.sendMessage(room.id, body, controller.signal);
      if (!active.current || controller.signal.aborted) return;
      timeline.receive(result);
      setMessages(timeline.snapshot().messages);
      setDraft("");
    } catch {
      if (active.current && !controller.signal.aborted)
        setError(
          "전송을 확인하지 못했어요. 대화 기록을 확인한 뒤 다시 시도해주세요.",
        );
    } finally {
      sendingRef.current = false;
      if (active.current) setSending(false);
    }
  }
  async function reply() {
    setReplying(true);
    try {
      const message = await onReply(room.id);
      if (active.current) {
        timeline.receive(message);
        setMessages(timeline.snapshot().messages);
      }
    } catch {
      if (active.current) setError("답장 체험을 실행하지 못했어요.");
    } finally {
      if (active.current) setReplying(false);
    }
  }
  return (
    <>
      <div
        className="message-scroll"
        ref={scroll}
        aria-label="대화 내용"
        role="log"
        aria-live="polite"
      >
        <div className="conversation-start">
          <span>
            <Icon name="spark" size={18} />
          </span>
          <strong>두 사람의 첫 번째 페이지</strong>
          <p>
            {other?.name ?? "상대방"}님과의 인연이 시작됐어요.
            <br />
            서로를 존중하는 다정한 인사를 건네보세요.
          </p>
        </div>
        {loading ? <Busy text="대화 불러오는 중" /> : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message-row ${message.senderId === MY_ID ? "mine" : "theirs"}`}
          >
            {message.senderId !== MY_ID ? (
              <Avatar name={other?.name ?? "?"} tone={other?.tone} small />
            ) : null}
            <div className="message-bubble">{message.body}</div>
            <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
          </div>
        ))}
      </div>
      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : null}
      {!messages.length && !loading ? (
        <div className="icebreakers">
          <span>첫인사가 고민된다면</span>
          {["안녕하세요! 반가워요 :)", "요즘 즐겨 듣는 노래가 있나요?"].map(
            (text) => (
              <button key={text} onClick={() => setDraft(text)}>
                {text}
              </button>
            ),
          )}
        </div>
      ) : null}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="message-input">
          메시지
        </label>
        <textarea
          id="message-input"
          placeholder="작은 인사를 건네보세요"
          value={draft}
          maxLength={2000}
          rows={1}
          disabled={sending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <span className="character-count">{draft.length}/2000</span>
        <button
          className="send-button"
          type="submit"
          disabled={!draft.trim() || sending}
          aria-label="메시지 보내기"
        >
          {sending ? (
            <span className="spinner" />
          ) : (
            <Icon name="send" size={19} />
          )}
        </button>
      </form>
      <div className="chat-demo-bar">
        <span>DEMO · 상대방은 가상 인물이에요</span>
        <button
          disabled={replying}
          onClick={() => {
            void reply();
          }}
        >
          {replying ? "답장 준비 중" : "상대 답장 체험"}
          <Icon name="arrow" size={13} />
        </button>
      </div>
    </>
  );
}

export function ChatPanel({
  rooms,
  requests,
  selection,
  onSelect,
  onAccept,
  onReject,
  onDemoAccept,
  api,
  onReply,
  busy,
}: {
  rooms: ConversationResponse[];
  requests: ChatRequestResponse[];
  selection: ChatSelection;
  onSelect: (value: ChatSelection) => void;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onDemoAccept: (id: string) => Promise<void>;
  api: Api;
  onReply: (id: string) => Promise<ChatMessage>;
  busy: boolean;
}) {
  const pending = requests.filter((r) => r.status === "pending");
  const room =
    selection?.kind === "room"
      ? rooms.find((r) => r.id === selection.id)
      : undefined;
  const invitation =
    selection?.kind === "request"
      ? requests.find((r) => r.id === selection.id)
      : undefined;
  const otherId =
    room?.members.find((id) => id !== MY_ID) ??
    (invitation?.from === MY_ID ? invitation.to : invitation?.from);
  const other = profiles.find((p) => p.id === otherId);
  return (
    <div className={`chat-layout ${selection ? "has-selection" : ""}`}>
      <aside className="conversation-list" aria-label="대화 목록">
        <div className="list-title">
          <h2>나의 대화</h2>
          <span>{rooms.length}</span>
        </div>
        {pending.length ? (
          <div className="list-section-label">
            대화 요청 <span>{pending.length}</span>
          </div>
        ) : null}
        {pending.map((request) => {
          const peer = profiles.find(
            (p) =>
              p.id === (request.from === MY_ID ? request.to : request.from),
          );
          return (
            <button
              key={request.id}
              className={`conversation-item ${selection?.id === request.id ? "active" : ""}`}
              onClick={() => onSelect({ kind: "request", id: request.id })}
            >
              <Avatar name={peer?.name ?? "?"} tone={peer?.tone} small />
              <span>
                <strong>{peer?.name ?? "알 수 없는 사용자"}</strong>
                <small>
                  {request.to === MY_ID
                    ? "새로운 대화 요청이 왔어요"
                    : "수락을 기다리고 있어요"}
                </small>
              </span>
              <span
                className={`request-dot ${request.to === MY_ID ? "new" : ""}`}
              />
            </button>
          );
        })}
        <div className="list-section-label">이어가는 인연</div>
        {rooms.length ? (
          rooms.map((item) => {
            const peer = profiles.find((p) => item.members.includes(p.id));
            return (
              <button
                key={item.id}
                className={`conversation-item ${selection?.id === item.id ? "active" : ""}`}
                onClick={() => onSelect({ kind: "room", id: item.id })}
              >
                <Avatar name={peer?.name ?? "?"} tone={peer?.tone} small />
                <span>
                  <strong>{peer?.name ?? "알 수 없는 사용자"}</strong>
                  <small>대화를 이어가 보세요</small>
                </span>
                <Icon name="arrow" size={15} />
              </button>
            );
          })
        ) : (
          <p className="list-empty">
            아직 시작한 대화가 없어요.
            <br />
            마음이 닿는 인연을 찾아보세요.
          </p>
        )}
        <div className="list-footnote">
          <Icon name="lock" size={14} />
          대화는 참여한 두 사람만 볼 수 있어요.
        </div>
      </aside>
      <section className="conversation-main" aria-label="선택한 대화">
        {other ? (
          <header className="conversation-header">
            <button
              className="icon-button chat-back"
              aria-label="대화 목록으로"
              onClick={() => onSelect(null)}
            >
              <Icon name="back" />
            </button>
            <Avatar name={other.name} tone={other.tone} small />
            <div>
              <strong>{other.name}</strong>
              <span>
                {other.major} · {other.year}
              </span>
            </div>
            <span className="private-badge">
              <Icon name="lock" size={13} />
              1:1 대화
            </span>
          </header>
        ) : null}
        {room ? (
          <Conversation key={room.id} room={room} api={api} onReply={onReply} />
        ) : invitation ? (
          <div className="request-view">
            <div className="request-art">
              <Avatar name={other?.name ?? "?"} tone={other?.tone} />
              <span>
                <Icon name="chat" size={24} />
              </span>
            </div>
            <span className="eyebrow">A NEW CONNECTION</span>
            <h2>
              {invitation.to === MY_ID
                ? `${other?.name}님이 인사를 건넸어요`
                : `${other?.name}님의 수락을 기다려요`}
            </h2>
            <p>
              {invitation.to === MY_ID
                ? "서로를 알아갈 작은 기회예요.\n마음이 괜찮다면 대화를 시작해보세요."
                : "요청을 잘 전달했어요.\n상대가 수락하면 이곳에서 대화를 나눌 수 있어요."}
            </p>
            {invitation.status !== "pending" ? (
              <div className="soft-label">
                {invitation.status === "rejected"
                  ? "거절한 요청이에요"
                  : "이미 수락한 요청이에요"}
              </div>
            ) : invitation.to === MY_ID ? (
              <>
                <div className="request-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void onReject(invitation.id);
                    }}
                  >
                    정중히 거절
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => {
                      void onAccept(invitation.id);
                    }}
                  >
                    {busy ? <Busy text="처리 중" /> : "수락하고 대화하기"}
                    <Icon name="arrow" size={17} />
                  </button>
                </div>
                <span className="free-note">
                  받은 요청은 무료로 수락하고 답장할 수 있어요.
                </span>
              </>
            ) : (
              <div className="demo-action">
                <span>데모에서 다음 화면을 확인해보세요</span>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void onDemoAccept(invitation.id);
                  }}
                >
                  {busy ? "처리 중" : "상대 수락 체험"}
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-chat">
            <div className="empty-orbit">
              <Icon name="chat" size={32} />
            </div>
            <span className="eyebrow">YOUR NEXT CHAPTER</span>
            <h2>
              좋은 대화의 시작은
              <br />
              작은 인사 한마디
            </h2>
            <p>왼쪽에서 대화나 받은 요청을 선택해보세요.</p>
          </div>
        )}
      </section>
    </div>
  );
}
