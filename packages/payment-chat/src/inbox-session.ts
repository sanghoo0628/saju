import type {
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import { PaymentChatClientError, type createBrowserClient } from "./client.ts";
import { schedule, type Schedule } from "./message-source.ts";
import { compareTimestamps } from "./compare-timestamps.ts";

export type InboxSelection = { kind: "request" | "room"; id: string } | null;
export interface InboxSnapshot {
  userId: string;
  requests: ChatRequestResponse[];
  rooms: ConversationResponse[];
  loading: boolean;
  refreshing: boolean;
  error: string;
  accessDenied: boolean;
  requestsComplete: boolean;
  roomsComplete: boolean;
}
const id = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 128;
const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const order = (
  a: { id: string; createdAt: string },
  b: { id: string; createdAt: string },
) =>
  compareTimestamps(b.createdAt, a.createdAt) ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const copyRequest = (r: ChatRequestResponse): ChatRequestResponse => ({
  id: r.id,
  from: r.from,
  to: r.to,
  orderId: r.orderId,
  status: r.status,
  createdAt: r.createdAt,
});
const copyRoom = (r: ConversationResponse): ConversationResponse => ({
  id: r.id,
  members: [...r.members],
  createdAt: r.createdAt,
});

/** Poll authenticated read APIs; publishing is atomic across the two independently fetched lists. */
export function createInboxSession(options: {
  userId: string;
  client: Pick<
    ReturnType<typeof createBrowserClient>,
    "requests" | "conversations"
  >;
  pollMs?: number;
  timeoutMs?: number;
  maxPages?: number;
  schedule?: Schedule;
}) {
  if (!id(options.userId)) throw new Error("Authenticated user ID is required");
  const pollMs = options.pollMs ?? 5000,
    timeoutMs = options.timeoutMs ?? 15000,
    maxPages = options.maxPages ?? 10;
  if (
    !Number.isFinite(pollMs) ||
    pollMs < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 50
  )
    throw new Error("Invalid inbox refresh configuration");
  const later = options.schedule ?? schedule;
  let active = false,
    disposed = false,
    denied = false,
    initialized = false,
    rerun = false;
  let requests: ChatRequestResponse[] = [],
    rooms: ConversationResponse[] = [];
  let loading = true,
    refreshing = false,
    error = "",
    requestsComplete = false,
    roomsComplete = false;
  let controller: AbortController | undefined,
    cancelPoll: (() => void) | undefined,
    running: Promise<void> | undefined;
  const observers = new Set<(state: InboxSnapshot) => void>();
  const snapshot = (): InboxSnapshot => ({
    userId: options.userId,
    requests: requests.map(copyRequest),
    rooms: rooms.map(copyRoom),
    loading,
    refreshing,
    error,
    accessDenied: denied,
    requestsComplete,
    roomsComplete,
  });
  const emit = () => {
    for (const observer of observers) {
      try {
        observer(snapshot());
      } catch {
        /* UI observer failures do not stop refresh. */
      }
    }
  };
  function validRequest(v: ChatRequestResponse) {
    return (
      v &&
      id(v.id) &&
      id(v.from) &&
      id(v.to) &&
      v.from !== v.to &&
      (v.from === options.userId || v.to === options.userId) &&
      id(v.orderId) &&
      ["pending", "accepted", "rejected"].includes(v.status) &&
      date(v.createdAt)
    );
  }
  function validRoom(v: ConversationResponse) {
    return (
      v &&
      id(v.id) &&
      Array.isArray(v.members) &&
      v.members.length === 2 &&
      v.members.every(id) &&
      v.members[0] !== v.members[1] &&
      v.members.includes(options.userId) &&
      date(v.createdAt)
    );
  }
  async function pages<T extends { id: string; createdAt: string }>(
    read: (after?: string, signal?: AbortSignal) => Promise<T[]>,
    valid: (v: T) => boolean,
    copy: (v: T) => T,
    signal: AbortSignal,
  ) {
    const rows = new Map<string, T>(),
      cursors = new Set<string>();
    let after: string | undefined;
    for (let n = 0; n < maxPages; n++) {
      signal.throwIfAborted();
      const page = await read(after, signal);
      signal.throwIfAborted();
      if (
        !Array.isArray(page) ||
        page.length > 100 ||
        page.some((v) => !valid(v))
      )
        throw new Error("Invalid inbox response");
      for (const row of page) rows.set(row.id, copy(row));
      if (page.length < 100)
        return { rows: [...rows.values()].sort(order), complete: true };
      const next = page.at(-1)!.id;
      if (cursors.has(next)) throw new Error("Inbox cursor did not advance");
      cursors.add(next);
      after = next;
    }
    return { rows: [...rows.values()].sort(order), complete: false };
  }
  function refresh(force = false): Promise<void> {
    if (!active || denied) return Promise.resolve();
    if (running) {
      if (force) {
        rerun = true;
        controller?.abort();
      }
      return running;
    }
    const operation = Promise.resolve().then(async () => {
      do {
        if (!active || denied) break;
        rerun = false;
        refreshing = true;
        loading = !initialized;
        emit();
        const current = (controller = new AbortController());
        let timedOut = false;
        const cancelTimeout = later(() => {
          timedOut = true;
          current.abort(new DOMException("Inbox timeout", "TimeoutError"));
        }, timeoutMs);
        let removeAbort = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          const abort = () => reject(current.signal.reason);
          current.signal.addEventListener("abort", abort, { once: true });
          removeAbort = () =>
            current.signal.removeEventListener("abort", abort);
        });
        try {
          const [nextRequests, nextRooms] = await Promise.race([
            Promise.all([
              pages(
                options.client.requests,
                validRequest,
                copyRequest,
                current.signal,
              ),
              pages(
                options.client.conversations,
                validRoom,
                copyRoom,
                current.signal,
              ),
            ]),
            aborted,
          ]);
          if (!active || denied || current.signal.aborted) continue;
          requests = nextRequests.rows;
          rooms = nextRooms.rows;
          requestsComplete = nextRequests.complete;
          roomsComplete = nextRooms.complete;
          initialized = true;
          error = "";
        } catch (failure) {
          if (!active) break;
          if (current.signal.aborted && !timedOut) continue;
          if (
            failure instanceof PaymentChatClientError &&
            [401, 403].includes(failure.status)
          ) {
            denied = true;
            requests = [];
            rooms = [];
            requestsComplete = true;
            roomsComplete = true;
            error =
              failure.status === 401
                ? "로그인이 만료됐어요. 다시 로그인한 뒤 확인해주세요."
                : "대화 목록에 접근할 수 없어요. 로그인 상태를 확인해주세요.";
            cancelPoll?.();
          } else
            error = timedOut
              ? "대화 목록 확인이 지연되고 있어요. 연결을 확인한 뒤 다시 시도해주세요."
              : "대화 목록을 불러오지 못했어요. 연결을 확인하고 다시 시도해주세요.";
          current.abort();
        } finally {
          cancelTimeout();
          removeAbort();
          refreshing = false;
          loading = false;
          if (active && !rerun) emit();
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
    if (active && !denied)
      cancelPoll = later(() => {
        if (active && !denied) {
          void refresh();
          poll();
        }
      }, pollMs);
  };
  return {
    snapshot,
    subscribe(observer: (state: InboxSnapshot) => void) {
      if (disposed) throw new Error("Inbox is disposed");
      observers.add(observer);
      try {
        observer(snapshot());
      } catch {
        /* Observer isolation. */
      }
      return () => {
        observers.delete(observer);
      };
    },
    start() {
      if (disposed) throw new Error("Inbox is disposed");
      if (active) return;
      active = true;
      void refresh();
      poll();
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      controller?.abort();
      cancelPoll?.();
      requests = [];
      rooms = [];
      loading = false;
      refreshing = false;
      observers.clear();
    },
  };
}
export type InboxSession = ReturnType<typeof createInboxSession>;

/** A URL is a selection hint, never permission to fetch or display an unlisted request/room. */
export function initialInboxSelection(selection: InboxSelection, userId: string, state: InboxSnapshot): InboxSelection {
  if (!selection || state.userId !== userId || state.accessDenied || state.loading || state.error) return null;
  if (selection.kind === 'room') return state.rooms.some(room => room.id === selection.id && room.members.includes(userId)) ? selection : null;
  return state.requests.some(request => request.id === selection.id && (request.from === userId || request.to === userId)) ? selection : null;
}

/** Reconcile only the view the user selected; never open an unsolicited request automatically. */
export function reconcileInboxSelection(
  selection: InboxSelection,
  userId: string,
  state: InboxSnapshot,
): InboxSelection {
  if (!selection || state.userId !== userId) return null;
  if (state.accessDenied) return null;
  // Only a successfully committed refresh can prove a selected item disappeared.
  if (state.refreshing || state.loading || state.error) return selection;
  if (selection.kind === "room")
    return state.rooms.some(
      (r) => r.id === selection.id && r.members.includes(userId),
    )
      ? selection
      : state.roomsComplete
        ? null
        : selection;
  const request = state.requests.find(
    (r) => r.id === selection.id && (r.from === userId || r.to === userId),
  );
  if (!request) return state.requestsComplete ? null : selection;
  if (request.status !== "accepted") return selection;
  const room = state.rooms.find(
    (r) => r.members.includes(request.from) && r.members.includes(request.to),
  );
  return room ? { kind: "room", id: room.id } : selection;
}
