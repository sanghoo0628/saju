import test from "node:test";
import assert from "node:assert/strict";
import { createService, ServiceError } from "../src/service.ts";
import type { Transaction, Order, MatchResult, ChatRequest, Conversation, CompletedPayment } from "../src/ports.ts";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";

const alice = { userId: "alice" }, bob = { userId: "bob" }, eve = { userId: "eve" };
const denied = (code: string) => (error: unknown) => error instanceof ServiceError && error.code === code;

/** 테스트 전용 메모리 저장소. 운영 DB/RLS 어댑터가 아니다. */
function fixture() {
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
          saveRequest: async request => { put(draft.requests, request); },
          conversation: async id => draft.rooms.find(x => x.id === id),
          conversationForPair: async (a,b) => draft.rooms.find(x => x.members.includes(a) && x.members.includes(b)),
          saveConversation: async room => { put(draft.rooms, room); },
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
        if (headers.get("x-test-verified") !== "yes") throw new Error("invalid signature");
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

test("상대별 500원 주문을 만들며 공개 추천 데이터는 결제로 변경하지 않는다", async () => {
  const f=fixture();
  const first=await f.service.createOrder(alice,"a-b");
  const second=await f.service.createOrder(alice,"a-c");
  assert.equal(first.kind,"payment_required");
  assert.equal(second.kind,"payment_required");
  assert.deepEqual(f.state.orders.map(x=>[x.targetId,x.amountKrw]),[["bob",500],["carol",500]]);
  assert.equal(f.state.results.length,4);
});

test("동일 프로필 동시 클릭은 미결제 주문 하나를 재사용한다", async () => {
  const f=fixture();
  const results=await Promise.all(Array.from({length:8},()=>f.service.createOrder(alice,"a-b")));
  assert.equal(f.state.orders.length,1);
  assert.equal(new Set(results.map(x=>x.kind === "payment_required" && x.orderId)).size,1);
});

test("다른 회원의 추천과 본인 추천에는 주문을 생성하지 않는다", async () => {
  const f=fixture();
  await assert.rejects(f.service.createOrder(eve,"a-b"),denied("FORBIDDEN"));
  f.state.results.push({id:"self",userId:"alice",targetId:"alice"});
  await assert.rejects(f.service.createOrder(alice,"self"),denied("FORBIDDEN"));
  assert.equal(f.state.orders.length,0);
});

test("미결제 주문은 대화 요청을 허용하지 않는다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await assert.rejects(f.service.requestChat(alice,order.orderId),denied("FORBIDDEN"));
});

test("잘못된 서명은 권한과 결제 기록을 생성하지 않는다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await assert.rejects(f.deliver(f.event(order.orderId),false),/invalid signature/);
  assert.equal(f.state.orders[0].status,"pending");
  assert.equal(f.state.payments.length,0);
});

test("금액·통화·상품·참조값이 틀린 이벤트를 거부한다", async () => {
  for(const override of [{amount:1},{currency:"USD"},{productId:"other"},{reference:"unknown"}]) {
    const f=fixture(), order=await f.service.createOrder(alice,"a-b");
    if(order.kind!=="payment_required") throw new Error();
    await assert.rejects(f.deliver(f.event(order.orderId,override)),denied("INVALID_REQUEST"));
    assert.equal(f.state.payments.length,0);
  }
});

test("동시 웹훅 재전송에도 결제 기록과 권한은 하나다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await Promise.all(Array.from({length:10},()=>f.deliver(f.event(order.orderId))));
  assert.equal(f.state.payments.length,1);
  assert.equal(f.state.orders[0].status,"fulfilled");
  assert.deepEqual(await f.service.createOrder(alice,"a-b"),{kind:"chat_available",orderId:order.orderId});
});

test("한 결제 식별자를 다른 프로필 주문에 재사용할 수 없다", async () => {
  const f=fixture(), first=await f.paid();
  const second=await f.service.createOrder(alice,"a-c");
  if(second.kind!=="payment_required") throw new Error();
  await assert.rejects(f.deliver(f.event(second.orderId,{transactionId:`payment-${first}`})),denied("INVALID_REQUEST"));
  assert.equal(f.state.orders[1].status,"pending");
});

test("결제 중 상대가 비공개되면 대상 변경 없이 환불 대기로 전환한다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  f.state.profiles=f.state.profiles.filter(x=>x!=="bob");
  const result=await f.deliver(f.event(order.orderId));
  assert.equal(result.status,"refund_pending");
  assert.equal((await f.deliver(f.event(order.orderId))).status,"refund_pending");
  assert.equal(f.state.payments.length,1);
  assert.equal(f.state.orders[0].targetId,"bob");
  await assert.rejects(f.service.requestChat(alice,order.orderId),denied("FORBIDDEN"));
});

test("주문 조회와 대화 요청은 결제한 사용자만 가능하다", async () => {
  const f=fixture(), id=await f.paid();
  await assert.rejects(f.service.order(eve,id),denied("FORBIDDEN"));
  await assert.rejects(f.service.requestChat(eve,id),denied("FORBIDDEN"));
  assert.equal((await f.service.order(alice,id)).targetId,"bob");
});

test("환불된 주문은 웹훅 재전송으로 대화 권한이 복구되지 않는다", async () => {
  const f=fixture(), id=await f.paid();
  f.state.orders[0].status="refunded";
  assert.equal((await f.deliver(f.event(id))).status,"refunded");
  await assert.rejects(f.service.requestChat(alice,id),denied("FORBIDDEN"));
});

test("결제 기록 저장 중 예외가 나면 트랜잭션 전체가 롤백된다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  // payment 저장 후 profile 확인 중 예외가 나게 하여 중간 기록 잔류를 확인한다.
  const profiles=f.state.profiles;
  f.state.profiles=null as unknown as string[];
  await assert.rejects(f.deliver(f.event(order.orderId)));
  assert.equal(f.state.payments.length,0);
  assert.equal(f.state.orders[0].status,"pending");
  f.state.profiles=profiles;
});

test("한 상대 결제로 다른 상대와 채팅할 수 없다", async () => {
  const f=fixture(), id=await f.paid();
  const request=await f.service.requestChat(alice,id);
  assert.equal(request.to,"bob");
  await assert.rejects(f.service.acceptChat({userId:"carol"},request.id),denied("FORBIDDEN"));
});

test("수신자는 결제 없이 수락하고, 동시 수락은 채팅방 하나를 만든다", async () => {
  const f=fixture(), id=await f.paid(), request=await f.service.requestChat(alice,id);
  await assert.rejects(f.service.acceptChat(alice,request.id),denied("FORBIDDEN"));
  const rooms=await Promise.all(Array.from({length:5},()=>f.service.acceptChat(bob,request.id)));
  assert.equal(f.state.rooms.length,1);
  assert.equal(new Set(rooms.map(x=>x.conversationId)).size,1);
  const message=await f.service.sendMessage(bob,rooms[0].conversationId,"안녕!");
  assert.equal(message.senderId,"bob");
  assert.equal(f.state.orders.length,1);
  assert.deepEqual(await f.service.createOrder(bob,"b-a"),{kind:"chat_available",conversationId:rooms[0].conversationId});
});

test("거절한 요청은 반복 클릭해도 새로 생성하지 않는다", async () => {
  const f=fixture(), id=await f.paid(), request=await f.service.requestChat(alice,id);
  await f.service.rejectChat(bob,request.id);
  assert.equal((await f.service.requestChat(alice,id)).status,"rejected");
  assert.equal(f.state.requests.length,1);
  await assert.rejects(f.service.acceptChat(bob,request.id),denied("INVALID_REQUEST"));
});

test("제3자는 채팅 기록을 읽거나 메시지를 보낼 수 없다", async () => {
  const f=fixture(), room=await f.room();
  await assert.rejects(f.service.messages(eve,room),denied("FORBIDDEN"));
  await assert.rejects(f.service.sendMessage(eve,room,"침입"),denied("FORBIDDEN"));
});

test("차단 후에는 요청·전송·기록 조회를 차단한다", async () => {
  const f=fixture(), room=await f.room();
  f.state.blocks.push(["bob","alice"]);
  await assert.rejects(f.service.messages(alice,room),denied("BLOCKED"));
  await assert.rejects(f.service.sendMessage(bob,room,"차단됨"),denied("BLOCKED"));
  await assert.rejects(f.service.requestChat(alice,f.state.orders[0].id),denied("BLOCKED"));
});

test("빈 메시지·과도한 길이는 거부하고 재접속 커서 이후 기록을 반환한다", async () => {
  const f=fixture(), room=await f.room();
  for(const value of ["   ","x".repeat(2001)]) await assert.rejects(f.service.sendMessage(alice,room,value),denied("INVALID_REQUEST"));
  const first=await f.service.sendMessage(alice,room," 첫 메시지 ");
  const second=await f.service.sendMessage(bob,room,"답장");
  assert.equal(first.body,"첫 메시지");
  assert.deepEqual(await f.service.messages(alice,room,first.id),[second]);
  await assert.rejects(f.service.messages(alice,room,"other-room-message"),denied("INVALID_REQUEST"));
});
