import type { ChatMessage } from "../../../contracts/payment-chat.ts";
import type {
  Repository,
  Transaction,
  Order,
  ChatRequest,
  Conversation,
} from "../../payment-chat/src/ports.ts";
import { ServiceError } from "../../payment-chat/src/service.ts";
import { MY_ID, profiles } from "../src/catalog.ts";

/** 로컬 UI 데모 전용. 실제 DB 어댑터로 가져다 쓰지 않는다. */
export function createDemoStore() {
  const seedTime = new Date(Date.now() - 1000 * 60 * 12).toISOString();
  let state = {
    orders: [
      {
        id: "incoming-order",
        userId: "demo-minjun",
        targetId: MY_ID,
        reference: "incoming-reference",
        matchResultId: "incoming-match",
        amountKrw: 500,
        status: "fulfilled",
      },
    ] as Order[],
    payments: [] as { transactionId: string; orderId: string }[],
    requests: [
      {
        id: "incoming-request",
        from: "demo-minjun",
        to: MY_ID,
        orderId: "incoming-order",
        status: "pending",
        createdAt: seedTime,
      },
    ] as ChatRequest[],
    rooms: [] as Conversation[],
    messages: [] as ChatMessage[],
    blocks: [] as string[][],
    active: [MY_ID, ...profiles.map((p) => p.id)],
    results: profiles.map((p) => ({
      id: p.matchId,
      userId: MY_ID,
      targetId: p.id,
    })),
  };
  let tail = Promise.resolve();
  function put<T extends { id: string }>(list: T[], value: T) {
    const index = list.findIndex((x) => x.id === value.id);
    if (index < 0) list.push(value);
    else list[index] = value;
  }
  function page<T extends { id: string; createdAt: string }>(
    list: T[],
    afterId?: string,
    descending = true,
  ) {
    const sorted = [...list].sort(
      (a, b) =>
        (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) *
        (descending ? -1 : 1),
    );
    const i = afterId ? sorted.findIndex((x) => x.id === afterId) : -1;
    if (afterId && i < 0)
      throw new ServiceError("INVALID_REQUEST", "잘못된 조회 커서입니다.");
    return sorted.slice(i + 1, i + 101);
  }
  const repository: Repository = {
    transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
      const operation = tail.then(async () => {
        const draft = structuredClone(state);
        const blocked = (a: string, b: string) =>
          draft.blocks.some((pair) => pair.includes(a) && pair.includes(b));
        const tx: Transaction = {
          order: async (id) => draft.orders.find((x) => x.id === id),
          orderByReference: async (ref) =>
            draft.orders.find((x) => x.reference === ref),
          activeOrderForPair: async (a, b) =>
            draft.orders.find(
              (x) =>
                x.userId === a &&
                x.targetId === b &&
                ["pending", "fulfilled"].includes(x.status),
            ),
          saveOrder: async (value) => {
            put(draft.orders, value);
          },
          paymentOrder: async (id) =>
            draft.payments.find((x) => x.transactionId === id)?.orderId,
          savePayment: async (transactionId, orderId) => {
            const existing = draft.payments.find(
              (x) => x.transactionId === transactionId,
            );
            if (existing && existing.orderId !== orderId)
              throw new Error("Duplicate payment");
            if (!existing) draft.payments.push({ transactionId, orderId });
          },
          result: async (id) => draft.results.find((x) => x.id === id),
          profileAvailable: async (id) => draft.active.includes(id),
          blocked: async (a, b) => blocked(a, b),
          request: async (id) => draft.requests.find((x) => x.id === id),
          requestForPair: async (a, b) =>
            draft.requests.find((x) => x.from === a && x.to === b),
          requestsForUser: async (id, after) =>
            page(
              draft.requests.filter(
                (x) => (x.from === id || x.to === id) && !blocked(x.from, x.to),
              ),
              after,
            ),
          saveRequest: async (value) => {
            put(draft.requests, value);
          },
          conversation: async (id) => draft.rooms.find((x) => x.id === id),
          conversationForPair: async (a, b) =>
            draft.rooms.find(
              (x) => x.members.includes(a) && x.members.includes(b),
            ),
          conversationsForUser: async (id, after) =>
            page(
              draft.rooms.filter(
                (x) => x.members.includes(id) && !blocked(...x.members),
              ),
              after,
            ),
          saveConversation: async (value) => {
            put(draft.rooms, value);
          },
          saveMessage: async (value) => {
            draft.messages.push(value);
          },
          messages: async (id, after) =>
            page(
              draft.messages.filter((x) => x.conversationId === id),
              after,
              false,
            ),
        };
        const result = await run(tx);
        state = draft;
        return result;
      });
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
  return {
    repository,
    get state() {
      return state;
    },
  };
}
