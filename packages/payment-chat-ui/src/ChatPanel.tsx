"use client";

import { useEffect, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import { createBrowserClient } from "../../payment-chat/src/client.ts";
import {
  createMessageSession,
  type MessageSession,
} from "../../payment-chat/src/message-session.ts";
import type { InboxSelection } from "../../payment-chat/src/inbox-session.ts";
import type { MessageSource } from "../../payment-chat/src/message-source.ts";
import type { ChatProfile } from "./types.ts";
import { Avatar, Busy, Icon } from "./ui.tsx";

export type ChatSelection = InboxSelection;
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
  currentUserId,
  other,
  messageSource,
}: {
  messageSource?: MessageSource;
  currentUserId: string;
  other: ChatProfile | undefined;
  room: ConversationResponse;
  api: Api;
  onReply?: (id: string) => Promise<ChatMessage>;
}) {
  const sessionRef = useRef<MessageSession | null>(null);
  const [connection, setConnection] = useState(
    messageSource ? "connecting" : "polling",
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [sendError, setSendError] = useState("");
  const [replyError, setReplyError] = useState("");
  const [accessError, setAccessError] = useState("");
  const accessDenied = useRef(false);
  const reload = useRef<() => void>(() => {});
  const replyingRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replying, setReplying] = useState(false);
  const sendingRef = useRef(false);
  const sendController = useRef<AbortController | null>(null);
  const active = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    active.current = true;
    accessDenied.current = false;
    const session = createMessageSession({
      userId: currentUserId,
      conversation: room,
      client: api,
      source: messageSource,
    });
    sessionRef.current = session;
    const stop = session.subscribe((state) => {
      setMessages(state.messages);
      setLoading(state.loading);
      setHistoryError(state.historyError);
      setAccessError(state.accessError);
      setConnection(state.connection);
      accessDenied.current = !!state.accessError;
    });
    reload.current = () => {
      setLoading(true);
      void session.refresh();
    };
    session.start();
    const reconnect = () => {
      if (document.visibilityState === "visible") void session.refresh(true);
    };
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      active.current = false;
      stop();
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
      sendController.current?.abort();
      document.removeEventListener("visibilitychange", reconnect);
      reload.current = () => {};
    };
  }, [
    api,
    room.id,
    room.members[0],
    room.members[1],
    currentUserId,
    messageSource,
  ]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages.length]);
  async function send() {
    const body = draft.trim();
    if (!body || sendingRef.current || accessError || loading || historyError)
      return;
    sendingRef.current = true;
    setSending(true);
    setSendError("");
    const session = sessionRef.current;
    if (!session) {
      sendingRef.current = false;
      setSending(false);
      return;
    }
    const controller = (sendController.current = new AbortController());
    try {
      const result = await api.sendMessage(room.id, body, controller.signal);
      if (
        !active.current ||
        controller.signal.aborted ||
        accessDenied.current ||
        sessionRef.current !== session
      )
        return;
      session.receive(result);
      setDraft("");
    } catch (error) {
      if (active.current && !controller.signal.aborted) {
        if (sessionRef.current !== session) return;
        if (session.deny(error)) return;
        setSendError(
          "전송 여부를 확인하지 못했어요. 입력한 내용은 보관했어요. 중복 전송을 피하려면 대화 기록을 확인한 뒤 다시 보내주세요.",
        );
      }
    } finally {
      sendingRef.current = false;
      if (active.current) setSending(false);
    }
  }
  async function reply() {
    if (!onReply || replyingRef.current || accessError) return;
    replyingRef.current = true;
    setReplying(true);
    setReplyError("");
    const session = sessionRef.current;
    try {
      const message = await onReply(room.id);
      if (
        active.current &&
        !accessDenied.current &&
        session &&
        sessionRef.current === session
      )
        session.receive(message);
    } catch {
      if (active.current)
        setReplyError("답장 체험을 실행하지 못했어요. 다시 시도해주세요.");
    } finally {
      replyingRef.current = false;
      if (active.current) setReplying(false);
    }
  }
  return (
    <>
      <div
        className="message-scroll"
        ref={scroll}
        aria-label="대화 내용"
        aria-busy={loading}
        role="log"
        aria-live="polite"
      >
        <div className="conversation-start">
          <span>
            <Icon name="spark" size={18} />
          </span>
          <strong>두 사람의 첫 번째 페이지</strong>
          <p>
            {other?.nickname ?? "상대방"}님과의 인연이 시작됐어요.
            <br />
            서로를 존중하는 다정한 인사를 건네보세요.
          </p>
        </div>
        {messageSource ? (
          <p className="connection-note" role="status">
            {connection === "live"
              ? "실시간 연결됨"
              : connection === "connecting"
                ? "실시간 연결 중 · 기록도 확인하고 있어요"
                : connection === "auth_required"
                  ? "로그인과 대화 권한을 확인해주세요"
                  : connection === "closed"
                    ? "실시간 연결이 종료되어 기록 조회로 확인하고 있어요"
                    : "실시간 연결 재시도 중 · 기록 조회로 확인하고 있어요"}
          </p>
        ) : null}
        {loading ? <Busy text="대화 불러오는 중" /> : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message-row ${message.senderId === currentUserId ? "mine" : "theirs"}`}
          >
            {message.senderId !== currentUserId ? (
              <Avatar name={other?.nickname ?? "?"} tone={other?.tone} small />
            ) : null}
            <div className="message-bubble">{message.body}</div>
            <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
          </div>
        ))}
      </div>
      {accessError ? (
        <p className="chat-error" role="alert">
          {accessError}
        </p>
      ) : null}
      {historyError && !accessError ? (
        <div className="chat-feedback" role="alert">
          <p>{historyError}</p>
          <button
            className="secondary"
            disabled={loading}
            onClick={() => reload.current()}
          >
            {loading ? "확인 중" : "대화 다시 불러오기"}
          </button>
        </div>
      ) : null}
      {sendError && !accessError ? (
        <div className="chat-feedback" role="alert">
          <p>{sendError}</p>
          <button
            className="secondary"
            disabled={loading}
            onClick={() => reload.current()}
          >
            대화 기록 확인
          </button>
        </div>
      ) : null}
      {replyError && !accessError ? (
        <p className="chat-error" role="alert">
          {replyError}
        </p>
      ) : null}
      {!messages.length && !loading && !historyError && !accessError ? (
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
          disabled={sending || loading || !!historyError || !!accessError}
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
          disabled={
            !draft.trim() ||
            sending ||
            loading ||
            !!historyError ||
            !!accessError
          }
          aria-label="메시지 보내기"
        >
          {sending ? (
            <span className="spinner" />
          ) : (
            <Icon name="send" size={19} />
          )}
        </button>
      </form>
      {onReply ? (
        <div className="chat-demo-bar">
          <span>DEMO · 상대방은 가상 인물이에요</span>
          <button
            disabled={replying || !!accessError}
            onClick={() => {
              void reply();
            }}
          >
            {replying ? "답장 준비 중" : "상대 답장 체험"}
            <Icon name="arrow" size={13} />
          </button>
        </div>
      ) : null}
    </>
  );
}

export function ChatPanel({
  rooms: allRooms,
  requests: allRequests,
  currentUserId,
  profiles,
  messageSource,
  demo,
  selection,
  listLoading,
  listError,
  listHasMore = false,
  onReload,
  onSelect,
  onAccept,
  onReject,
  api,
  busy,
}: {
  rooms: ConversationResponse[];
  requests: ChatRequestResponse[];
  currentUserId: string;
  profiles: readonly ChatProfile[];
  messageSource?: MessageSource;
  demo?: {
    onAcceptRequest?: (id: string) => Promise<void>;
    onReply?: (id: string) => Promise<ChatMessage>;
  };
  selection: ChatSelection;
  listLoading: boolean;
  listError: string;
  listHasMore?: boolean;
  onReload: () => void;
  onSelect: (value: ChatSelection) => void;
  onAccept: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  api: Api;
  busy: boolean;
}) {
  // Defense in depth for stale parent data; authorization remains enforced by the server/RLS.
  const rooms = allRooms.filter((r) => r.members.includes(currentUserId));
  const requests = allRequests.filter(
    (r) => r.from === currentUserId || r.to === currentUserId,
  );
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
    room?.members.find((id) => id !== currentUserId) ??
    (invitation?.from === currentUserId ? invitation.to : invitation?.from);
  const other = profiles.find((p) => p.userId === otherId);
  return (
    <div className={`chat-layout ${room || invitation ? "has-selection" : ""}`}>
      <aside
        className="conversation-list"
        aria-label="대화 목록"
        aria-busy={listLoading}
      >
        <div className="list-title">
          <h2>나의 대화</h2>
          <span>{rooms.length}</span>
        </div>
        {listLoading ? (
          <div className="list-feedback">
            <Busy text="대화 목록 불러오는 중" />
          </div>
        ) : null}
        {listError ? (
          <div className="list-feedback" role="alert">
            <p>{listError}</p>
            <button
              className="secondary"
              disabled={listLoading}
              onClick={onReload}
            >
              목록 다시 불러오기
            </button>
          </div>
        ) : null}
        {listHasMore ? (
          <p className="list-feedback" role="status">
            목록이 많아 최근 내역부터 표시했어요.
          </p>
        ) : null}
        {pending.length ? (
          <div className="list-section-label">
            대화 요청 <span>{pending.length}</span>
          </div>
        ) : null}
        {pending.map((request) => {
          const peer = profiles.find(
            (p) =>
              p.userId ===
              (request.from === currentUserId ? request.to : request.from),
          );
          return (
            <button
              key={request.id}
              className={`conversation-item ${selection?.id === request.id ? "active" : ""}`}
              onClick={() => onSelect({ kind: "request", id: request.id })}
            >
              <Avatar name={peer?.nickname ?? "?"} tone={peer?.tone} small />
              <span>
                <strong>{peer?.nickname ?? "알 수 없는 사용자"}</strong>
                <small>
                  {request.to === currentUserId
                    ? "새로운 대화 요청이 왔어요"
                    : "수락을 기다리고 있어요"}
                </small>
              </span>
              <span
                className={`request-dot ${request.to === currentUserId ? "new" : ""}`}
              />
            </button>
          );
        })}
        <div className="list-section-label">이어가는 인연</div>
        {rooms.length ? (
          rooms.map((item) => {
            const peer = profiles.find(
              (p) =>
                p.userId !== currentUserId && item.members.includes(p.userId),
            );
            return (
              <button
                key={item.id}
                className={`conversation-item ${selection?.id === item.id ? "active" : ""}`}
                onClick={() => onSelect({ kind: "room", id: item.id })}
              >
                <Avatar name={peer?.nickname ?? "?"} tone={peer?.tone} small />
                <span>
                  <strong>{peer?.nickname ?? "알 수 없는 사용자"}</strong>
                  <small>대화를 이어가 보세요</small>
                </span>
                <Icon name="arrow" size={15} />
              </button>
            );
          })
        ) : !listLoading && !listError ? (
          <p className="list-empty">
            아직 시작한 대화가 없어요.
            <br />
            마음이 닿는 인연을 찾아보세요.
          </p>
        ) : null}
        <div className="list-footnote">
          <Icon name="lock" size={14} />
          대화는 참여한 두 사람만 볼 수 있어요.
        </div>
      </aside>
      <section className="conversation-main" aria-label="선택한 대화">
        {room || invitation ? (
          <header className="conversation-header">
            <button
              className="icon-button chat-back"
              aria-label="대화 목록으로"
              onClick={() => onSelect(null)}
            >
              <Icon name="back" />
            </button>
            <Avatar
              name={other?.nickname ?? "상대방"}
              tone={other?.tone}
              small
            />
            <div>
              <strong>{other?.nickname ?? "상대방"}</strong>
              <span>{other?.major ?? "공개된 학과 정보가 없어요"}</span>
            </div>
            <span className="private-badge">
              <Icon name="lock" size={13} />
              1:1 대화
            </span>
          </header>
        ) : null}
        {room ? (
          <Conversation
            key={`${currentUserId}:${room.id}`}
            room={room}
            api={api}
            currentUserId={currentUserId}
            other={other}
            messageSource={messageSource}
            onReply={demo?.onReply}
          />
        ) : invitation ? (
          <div className="request-view">
            <div className="request-art">
              <Avatar name={other?.nickname ?? "?"} tone={other?.tone} />
              <span>
                <Icon name="chat" size={24} />
              </span>
            </div>
            <span className="eyebrow">A NEW CONNECTION</span>
            <h2>
              {invitation.status === "rejected"
                ? invitation.to === currentUserId
                  ? "대화 요청을 거절했어요"
                  : "이번 요청은 수락되지 않았어요"
                : invitation.status === "accepted"
                  ? "대화 요청이 수락됐어요"
                  : invitation.to === currentUserId
                    ? `${other?.nickname ?? "상대방"}님이 인사를 건넸어요`
                    : `${other?.nickname ?? "상대방"}님의 수락을 기다려요`}
            </h2>
            <p>
              {invitation.status === "rejected"
                ? invitation.to === currentUserId
                  ? "이번 요청은 종료됐어요."
                  : "상대방이 이번 요청을 수락하지 않았어요."
                : invitation.status === "accepted"
                  ? "대화방을 확인하고 있어요. 잠시만 기다려주세요."
                  : invitation.to === currentUserId
                    ? "서로를 알아갈 작은 기회예요.\n마음이 괜찮다면 대화를 시작해보세요."
                    : "요청을 잘 전달했어요.\n상대가 수락하면 이곳에서 대화를 나눌 수 있어요."}
            </p>
            {invitation.status !== "pending" ? (
              <div className="soft-label">
                {invitation.status === "rejected" ? (
                  invitation.to === currentUserId ? (
                    "내가 거절한 요청이에요"
                  ) : (
                    "상대가 거절한 요청이에요"
                  )
                ) : (
                  <button
                    className="secondary"
                    disabled={busy || listLoading}
                    onClick={onReload}
                  >
                    대화방 다시 확인
                  </button>
                )}
              </div>
            ) : invitation.to === currentUserId ? (
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
            ) : demo?.onAcceptRequest ? (
              <div className="demo-action">
                <span>데모에서 다음 화면을 확인해보세요</span>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void demo.onAcceptRequest?.(invitation.id);
                  }}
                >
                  {busy ? "처리 중" : "상대 수락 체험"}
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            ) : null}
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
