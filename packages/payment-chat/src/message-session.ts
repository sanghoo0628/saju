import type {
  ChatMessage,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import { PaymentChatClientError, type createBrowserClient } from "./client.ts";
import { createMessageTimeline } from "./message-timeline.ts";
import {
  schedule,
  type Schedule,
  type MessageSource,
  type MessageSourceStatus,
} from "./message-source.ts";

export interface MessageSessionSnapshot {
  messages: ChatMessage[];
  loading: boolean;
  historyError: string;
  accessError: string;
  connection: MessageSourceStatus | "polling";
}
/** Realtime is an acceleration path. Authenticated HTTP reads remain the authority for access/history. */
export function createMessageSession(options: {
  userId: string;
  conversation: ConversationResponse;
  client: Pick<ReturnType<typeof createBrowserClient>, "messages">;
  source?: MessageSource;
  pollMs?: number;
  schedule?: Schedule;
}) {
  if (!options.userId || !options.conversation.members.includes(options.userId))
    throw new Error("Conversation membership is required");
  const pollMs = options.pollMs ?? 2500;
  if (!Number.isFinite(pollMs) || pollMs < 1)
    throw new Error("Invalid message poll interval");
  const later = options.schedule ?? schedule;
  const room = options.conversation;
  const timeline = createMessageTimeline(room.id);
  const observers = new Set<(snapshot: MessageSessionSnapshot) => void>();
  let active = false,
    disposed = false,
    denied = false,
    authorized = false;
  let loading = true,
    historyError = "",
    accessError = "";
  let connection: MessageSessionSnapshot["connection"] = options.source
    ? "connecting"
    : "polling";
  let controller: AbortController | undefined;
  let cancelPoll: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let rerun = false;
  const buffer = new Map<string, ChatMessage>();
  const snapshot = (): MessageSessionSnapshot => ({
    messages: timeline.snapshot().messages,
    loading,
    historyError,
    accessError,
    connection,
  });
  const emit = () => {
    for (const observer of observers) {
      try {
        observer(snapshot());
      } catch {
        /* UI observers are isolated. */
      }
    }
  };
  const valid = (m: ChatMessage) =>
    m &&
    m.conversationId === room.id &&
    room.members.includes(m.senderId) &&
    typeof m.id === "string" &&
    !!m.id &&
    typeof m.body === "string" &&
    !!m.body.trim() &&
    m.body.length <= 2000 &&
    typeof m.createdAt === "string" &&
    Number.isFinite(Date.parse(m.createdAt));
  const stopSource = () => {
    const stop = unsubscribe;
    unsubscribe = undefined;
    try {
      stop?.();
    } catch {
      /* Cleanup failure cannot retain private UI data. */
    }
  };
  function deny(error: unknown): boolean {
    if (!active || disposed) return false;
    if (
      !(error instanceof PaymentChatClientError) ||
      ![401, 403, 404].includes(error.status)
    )
      return false;
    denied = true;
    authorized = false;
    loading = false;
    accessError =
      error.status === 401
        ? "로그인이 만료됐어요. 다시 로그인한 뒤 대화를 열어주세요."
        : "이 대화에 접근할 수 없어요. 대화 목록에서 상태를 확인해주세요.";
    connection = "auth_required";
    timeline.clear();
    buffer.clear();
    controller?.abort();
    cancelPoll?.();
    stopSource();
    emit();
    return true;
  }
  function receive(message: ChatMessage) {
    if (!active || denied || !valid(message)) return false;
    // Buffer before the first successful access check and during reconnect revalidation.
    if (!authorized) {
      if (buffer.size >= 200) buffer.delete(buffer.keys().next().value!);
      buffer.set(message.id, {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        createdAt: message.createdAt,
      });
      return true;
    }
    if (!timeline.receive(message)) return false;
    emit();
    return true;
  }
  function refresh(restart = false): Promise<void> {
    if (!active || denied) return Promise.resolve();
    if (restart) {
      authorized = false;
      timeline.restartHistory();
      if (running) {
        rerun = true;
        controller?.abort();
      }
    }
    if (running) return running;
    const operation = Promise.resolve().then(async () => {
      do {
        rerun = false;
        controller = new AbortController();
        const signal = controller.signal;
        try {
          for (let i = 0; i < 10 && active && !denied; i++) {
            const token = timeline.nextHistoryPage();
            const page = await options.client.messages(
              room.id,
              token.afterId,
              signal,
            );
            if (!active || denied || signal.aborted) break;
            if (page.some((item) => !valid(item)))
              throw new Error("Invalid message history");
            if (!timeline.appendHistory(page, token)) {
              rerun = true;
              break;
            }
            authorized = true;
            for (const item of buffer.values())
              if (valid(item)) timeline.receive(item);
            buffer.clear();
            historyError = "";
            loading = false;
            emit();
            if (page.length < 100) break;
          }
        } catch (error) {
          if (active && !denied && !signal.aborted && !deny(error)) {
            historyError =
              "대화를 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해주세요.";
            loading = false;
            emit();
          }
        }
      } while (rerun && active && !denied);
    });
    running = operation;
    void operation
      .finally(() => {
        if (running === operation) running = undefined;
      })
      .catch(() => {});
    return operation;
  }
  const poll = () => {
    if (!active || denied) return;
    cancelPoll = later(() => {
      if (active && !denied) {
        void refresh();
        poll();
      }
    }, pollMs);
  };
  return {
    snapshot,
    subscribe(observer: (value: MessageSessionSnapshot) => void) {
      observers.add(observer);
      try {
        observer(snapshot());
      } catch {
        /* Isolate observers. */
      }
      return () => {
        observers.delete(observer);
      };
    },
    start() {
      if (disposed) throw new Error("Message session is disposed");
      if (active) return;
      active = true;
      emit();
      if (options.source) {
        try {
          const stop = options.source.subscribe({
            userId: options.userId,
            conversationId: room.id,
            onMessage: receive,
            onStatus: (status) => {
              if (!active || denied) return;
              if (status === "auth_required") {
                deny(
                  new PaymentChatClientError(
                    "UNAUTHENTICATED",
                    "로그인이 필요합니다.",
                    401,
                  ),
                );
                return;
              }
              connection = status;
              emit();
              if (status === "live") void refresh(true);
            },
          });
          if (!active || denied) {
            try {
              stop();
            } catch {
              /* Already stopped. */
            }
          } else unsubscribe = stop;
        } catch {
          connection = "reconnecting";
          emit();
        }
      }
      void refresh();
      poll();
    },
    refresh,
    receive,
    deny,
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      authorized = false;
      controller?.abort();
      cancelPoll?.();
      stopSource();
      timeline.clear();
      buffer.clear();
      observers.clear();
      connection = "closed";
      loading = false;
    },
  };
}
export type MessageSession = ReturnType<typeof createMessageSession>;
