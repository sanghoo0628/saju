import assert from "node:assert/strict";
import { createService, ServiceError } from "../src/service.ts";
import type { Transaction, Order, MatchResult, ChatRequest, Conversation, CompletedPayment } from "../src/ports.ts";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";

export const alice = { userId: "alice" }, bob = { userId: "bob" }, eve = { userId: "eve" };
export const denied = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

/** 테스트 전용 메모리 저장소. 운영 DB/RLS 어댑터가 아니다. */
export function fixture() {
  let state = {
    orders: [] as Order[], payments: [] as { transactionId: string; orderId: string }[],
    results: [
      { id: "a-b", userId: "alice", targetId: "bob" },
      { id: "a-c", userId: "alice", targetId: "carol" },
      { id: "a-d", userId: "alice", targetId: "dan" },
      { id: "b-a", userId: "bob", targetId: "alice" },
    ] as MatchResult[],
    requests: [] as ChatRequest[], rooms: [] as Conversation[], messages: [] as ChatMessage[],
    profiles: ["alice", "bob", "carol", "dan"], blocks: [] as string[][],
  };
  let tail = Promise.resolve();
  function put<T extends { id: string }>(items: T[], item: T) {
    const index = items.findIndex(x => x.id === item.id);
    if (index < 0) items.push(item); else items[index] = item;
  }
  function page<T extends {id:string;createdAt:string}>(items:T[], afterId?:string) {
    const sorted=[...items].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
    const index=afterId ? sorted.findIndex(x=>x.id===afterId) : -1;
    if(afterId && index<0) throw new ServiceError("INVALID_REQUEST","잘못된 커서");
    return sorted.slice(index+1,index+101);
  }
  const repository = {
    transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
      const operation = tail.then(async () => {
        const draft = structuredClone(state);
        const tx: Transaction = {
          order: async id => draft.orders.find(x => x.id === id),
          orderByReference: async ref => draft.orders.find(x => x.reference === ref),
          activeOrderForPair: async (a,b) => draft.orders.find(x => x.userId === a && x.targetId === b && ["pending","fulfilled"].includes(x.status)),
          saveOrder: async order => { put(draft.orders, order); },
          paymentOrder: async id => draft.payments.find(x => x.transactionId === id)?.orderId,
          savePayment: async (transactionId, orderId) => {
            const old = draft.payments.find(x => x.transactionId === transactionId);
            if (old && old.orderId !== orderId) throw new Error("unique payment constraint");
            if (!old) draft.payments.push({ transactionId, orderId });
          },
          result: async id => draft.results.find(x => x.id === id),
          profileAvailable: async id => draft.profiles.includes(id),
          blocked: async (a,b) => draft.blocks.some(pair => pair.includes(a) && pair.includes(b)),
          request: async id => draft.requests.find(x => x.id === id),
          requestForPair: async (a,b) => draft.requests.find(x => x.from === a && x.to === b),
          requestsForUser: async (userId,afterId) => page(draft.requests.filter(x=>(x.from===userId||x.to===userId) && !draft.blocks.some(pair=>pair.includes(x.from)&&pair.includes(x.to))),afterId),
          saveRequest: async request => { put(draft.requests, request); },
          conversation: async id => draft.rooms.find(x => x.id === id),
          conversationForPair: async (a,b) => draft.rooms.find(x => x.members.includes(a) && x.members.includes(b)),
          conversationsForUser: async (userId,afterId) => page(draft.rooms.filter(x=>x.members.includes(userId) && !draft.blocks.some(pair=>x.members.every(member=>pair.includes(member)))),afterId),
          saveConversation: async room => { put(draft.rooms, room); },
          message: async id => draft.messages.find(message => message.id === id),
          saveMessage: async message => { draft.messages.push(message); },
          messages: async (roomId, afterId) => {
            const messages = draft.messages.filter(x => x.conversationId === roomId).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
            if (afterId && !messages.some(x => x.id === afterId)) throw new ServiceError("INVALID_REQUEST", "잘못된 커서");
            return messages.slice(afterId ? messages.findIndex(x => x.id === afterId) + 1 : 0, 100);
          },
        };
        const result = await run(tx);
        state = draft;
        return result;
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
  let sequence = 0;
  const service = createService({ repository, id: () => `id-${String(++sequence).padStart(5,"0")}`,
    now: () => "2026-11-16T12:00:00.000Z",
    gateway: {
      productId: "chat-one-profile",
      checkoutUrl: ref => `https://example.invalid/checkout?ref=${ref}`,
      // 테스트 전용 검증기. Groble 서명 규격을 모사하지 않는다.
      verifyCompleted: async (raw, headers) => {
        if (headers.get("x-test-verified") !== "yes") throw new ServiceError("INVALID_WEBHOOK", "invalid signature");
        return JSON.parse(new TextDecoder().decode(raw)) as CompletedPayment;
      },
    },
  });
  function event(orderId: string, override: Partial<CompletedPayment> = {}) {
    const order = state.orders.find(x => x.id === orderId)!;
    return { reference: order.reference, transactionId: `payment-${orderId}`, productId: "chat-one-profile", amount: 500, currency: "KRW", ...override };
  }
  async function deliver(payment: CompletedPayment, valid = true) {
    return service.paymentWebhook(new TextEncoder().encode(JSON.stringify(payment)), new Headers(valid ? { "x-test-verified": "yes" } : {}));
  }
  async function paid(target = "a-b") {
    const order = await service.createOrder(alice, target);
    assert.equal(order.kind, "payment_required");
    if (order.kind !== "payment_required") throw new Error("fixture order");
    await deliver(event(order.orderId));
    return order.orderId;
  }
  async function room() {
    const orderId = await paid();
    const request = await service.requestChat(alice, orderId);
    return (await service.acceptChat(bob, request.id)).conversationId;
  }
  return { service, event, deliver, paid, room, get state() { return state; } };
}
