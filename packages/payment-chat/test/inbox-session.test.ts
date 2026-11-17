import { createDemoStore } from "../../payment-chat-ui/demo/store.ts";
import { createService } from "../src/service.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createInboxSession,
  reconcileInboxSelection,
} from "../src/inbox-session.ts";
import { PaymentChatClientError, createBrowserClient } from "../src/client.ts";
import { createHttpApi } from "../src/http.ts";
import { fixture as serverFixture } from "./fixtures.ts";
import { clock, flush, deferred } from "./realtime-fixtures.ts";
import type {
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
const ME = "alice",
  PEER = "bob";
const request = (n = 1): ChatRequestResponse => ({
  id: `request-${n}`,
  from: ME,
  to: PEER,
  orderId: `order-${n}`,
  status: "pending",
  createdAt: new Date(1800000000000 + n * 1000).toISOString(),
});
const room = (n = 1): ConversationResponse => ({
  id: `room-${n}`,
  members: [ME, PEER],
  createdAt: request(n).createdAt,
});
function setup() {
  const c = clock();
  let requests = [request()],
    rooms: ConversationResponse[] = [];
  let readRequests: (
    after?: string,
    signal?: AbortSignal,
  ) => Promise<ChatRequestResponse[]> = async () => requests;
  let readRooms: (
    after?: string,
    signal?: AbortSignal,
  ) => Promise<ConversationResponse[]> = async () => rooms;
  let requestReads = 0,
    roomReads = 0;
  const session = createInboxSession({
    userId: ME,
    schedule: c.schedule,
    client: {
      requests: (...args) => {
        requestReads++;
        return readRequests(...args);
      },
      conversations: (...args) => {
        roomReads++;
        return readRooms(...args);
      },
    },
  });
  return {
    session,
    c,
    set requests(value: ChatRequestResponse[]) {
      requests = value;
    },
    set rooms(value: ConversationResponse[]) {
      rooms = value;
    },
    set readRequests(value: typeof readRequests) {
      readRequests = value;
    },
    set readRooms(value: typeof readRooms) {
      readRooms = value;
    },
    get reads() {
      return { requestReads, roomReads };
    },
    tick(delay = 5000) {
      const job = c.jobs.find((x) => x.active && x.delay === delay);
      assert.ok(job);
      job.active = false;
      job.run();
    },
  };
}

test("목록 두 개가 모두 성공한 뒤에만 함께 반영한다", async () => {
  const f = setup(),
    response = deferred<ConversationResponse[]>();
  f.readRooms = () => response.promise;
  f.session.start();
  await flush();
  assert.deepEqual(f.session.snapshot().requests, []);
  assert.equal(f.session.snapshot().loading, true);
  response.resolve([room()]);
  await flush();
  assert.deepEqual(f.session.snapshot().requests, [request()]);
  assert.deepEqual(f.session.snapshot().rooms, [room()]);
  f.session.dispose();
});
test("주기 조회로 새 요청과 수락 상태를 반영하고 선택한 요청을 해당 방으로 잇는다", async () => {
  const f = setup();
  f.session.start();
  await flush();
  let selection = { kind: "request" as const, id: request().id };
  assert.deepEqual(
    reconcileInboxSelection(selection, ME, f.session.snapshot()),
    selection,
  );
  f.requests = [{ ...request(), status: "accepted" }, request(2)];
  f.rooms = [room()];
  f.tick();
  await flush();
  assert.equal(f.session.snapshot().requests.length, 2);
  assert.deepEqual(
    reconcileInboxSelection(selection, ME, f.session.snapshot()),
    { kind: "room", id: room().id },
  );
  f.session.dispose();
});
test("선택하지 않은 요청이나 다른 상대의 방은 자동으로 열지 않는다", async () => {
  const f = setup();
  f.requests = [{ ...request(), status: "accepted" }];
  f.rooms = [{ ...room(), members: [ME, "carol"] }];
  f.session.start();
  await flush();
  assert.equal(reconcileInboxSelection(null, ME, f.session.snapshot()), null);
  assert.deepEqual(
    reconcileInboxSelection(
      { kind: "request", id: request().id },
      ME,
      f.session.snapshot(),
    ),
    { kind: "request", id: request().id },
  );
  f.session.dispose();
});
test("거절한 요청은 새로 만들지 않고 결과 상태로 남긴다", async () => {
  const f = setup();
  f.session.start();
  await flush();
  f.requests = [{ ...request(), status: "rejected" }];
  f.tick();
  await flush();
  assert.equal(f.session.snapshot().requests[0]!.status, "rejected");
  assert.deepEqual(
    reconcileInboxSelection(
      { kind: "request", id: request().id },
      ME,
      f.session.snapshot(),
    ),
    { kind: "request", id: request().id },
  );
  f.session.dispose();
});
test("차단 등으로 완전한 목록에서 사라진 요청·방은 보관하지 않는다", async () => {
  const f = setup();
  f.rooms = [room()];
  f.session.start();
  await flush();
  f.rooms = [];
  f.requests = [];
  f.tick();
  await flush();
  assert.deepEqual(f.session.snapshot().rooms, []);
  assert.equal(
    reconcileInboxSelection(
      { kind: "room", id: room().id },
      ME,
      f.session.snapshot(),
    ),
    null,
  );
  assert.equal(
    reconcileInboxSelection(
      { kind: "request", id: request().id },
      ME,
      f.session.snapshot(),
    ),
    null,
  );
  f.session.dispose();
});
test("다른 사용자 컨텍스트의 스냅샷은 선택 상태에 적용하지 않는다", async () => {
  const f = setup();
  f.session.start();
  await flush();
  assert.equal(
    reconcileInboxSelection(
      { kind: "request", id: request().id },
      "eve",
      f.session.snapshot(),
    ),
    null,
  );
  f.session.dispose();
});
test("100개 페이지를 이어 읽고 중복 ID를 합친다", async () => {
  const f = setup(),
    rows = Array.from({ length: 101 }, (_, i) => request(101 - i)),
    cursors: (string | undefined)[] = [];
  f.readRequests = async (after) => {
    cursors.push(after);
    return after ? [rows[99]!, rows[100]!] : rows.slice(0, 100);
  };
  f.session.start();
  await flush();
  assert.equal(f.session.snapshot().requests.length, 101);
  assert.equal(f.session.snapshot().requestsComplete, true);
  assert.deepEqual(cursors, [undefined, rows[99]!.id]);
  f.session.dispose();
});
test("페이지 한도를 알리고 잘린 목록만으로 이전 선택을 삭제하지 않는다", async () => {
  const c = clock(),
    session = createInboxSession({
      userId: ME,
      schedule: c.schedule,
      maxPages: 1,
      client: {
        requests: async () => Array.from({ length: 100 }, (_, i) => request(i)),
        conversations: async () => [],
      },
    });
  session.start();
  await flush();
  assert.equal(session.snapshot().requestsComplete, false);
  const selection = { kind: "request" as const, id: "old-request" };
  assert.deepEqual(
    reconcileInboxSelection(selection, ME, session.snapshot()),
    selection,
  );
  session.dispose();
});
test("페이지 커서가 전진하지 않으면 반복하지 않고 오류를 표시한다", async () => {
  const f = setup();
  f.readRequests = async () =>
    Array.from({ length: 100 }, (_, i) => request(i));
  f.session.start();
  await flush();
  assert.ok(f.session.snapshot().error);
  assert.equal(f.reads.requestReads, 2);
  f.session.dispose();
});
test("일시적 실패는 이전 목록을 유지하고 다음 조회에서 복구한다", async () => {
  const f = setup();
  f.session.start();
  await flush();
  f.readRooms = async () => {
    throw new TypeError("offline");
  };
  f.tick();
  await flush();
  assert.deepEqual(f.session.snapshot().requests, [request()]);
  assert.ok(f.session.snapshot().error);
  f.readRooms = async () => [room()];
  f.tick();
  await flush();
  assert.equal(f.session.snapshot().error, "");
  assert.deepEqual(f.session.snapshot().rooms, [room()]);
  f.session.dispose();
});
test("인증·권한 오류는 목록을 지우고 자동 조회를 중단한다", async () => {
  for (const status of [401, 403]) {
    const f = setup();
    f.rooms = [room()];
    f.session.start();
    await flush();
    f.readRequests = async () => {
      throw new PaymentChatClientError("FORBIDDEN", "denied", status);
    };
    f.tick();
    await flush();
    assert.deepEqual(f.session.snapshot().requests, []);
    assert.deepEqual(f.session.snapshot().rooms, []);
    assert.ok(f.session.snapshot().error);
    assert.equal(f.c.jobs.filter((x) => x.active).length, 0);
    assert.equal(
      reconcileInboxSelection(
        { kind: "room", id: room().id },
        ME,
        f.session.snapshot(),
      ),
      null,
    );
    f.session.dispose();
  }
});
test("조회가 멈춰도 제한 시간이 지나면 안내하고 다시 조회할 수 있다", async () => {
  const f = setup();
  f.readRequests = () => new Promise(() => {});
  f.session.start();
  await flush();
  f.tick(15000);
  await flush();
  assert.match(f.session.snapshot().error, /지연/);
  assert.equal(f.session.snapshot().refreshing, false);
  f.readRequests = async () => [request()];
  f.tick();
  await flush();
  assert.equal(f.session.snapshot().error, "");
  f.session.dispose();
});
test("일반 조회 중복은 합치고 강제 갱신은 오래된 응답을 버린다", async () => {
  const f = setup(),
    old = deferred<ChatRequestResponse[]>();
  let calls = 0;
  f.readRequests = async () => (++calls === 1 ? old.promise : [request(2)]);
  f.session.start();
  await flush();
  const a = f.session.refresh(),
    b = f.session.refresh();
  assert.equal(a, b);
  const forced = f.session.refresh(true);
  await flush();
  assert.deepEqual(f.session.snapshot().requests, [request(2)]);
  old.resolve([request(1)]);
  await forced;
  await flush();
  assert.deepEqual(f.session.snapshot().requests, [request(2)]);
  f.session.dispose();
});
test("사용자가 다른 대화를 선택한 뒤에도 강제 갱신 결과는 그 선택을 가로채지 않는다", async () => {
  const f = setup();
  f.rooms = [room(1), room(2)];
  f.requests = [{ ...request(), status: "accepted" }];
  f.session.start();
  await flush();
  assert.deepEqual(
    reconcileInboxSelection(
      { kind: "room", id: room(2).id },
      ME,
      f.session.snapshot(),
    ),
    { kind: "room", id: room(2).id },
  );
  f.session.dispose();
});
test("해제 후 도착한 응답·타이머는 기록이나 구독자를 갱신하지 않는다", async () => {
  const f = setup(),
    response = deferred<ChatRequestResponse[]>();
  f.readRequests = () => response.promise;
  let updates = 0;
  f.session.subscribe(() => updates++);
  f.session.start();
  await flush();
  f.session.dispose();
  const count = updates;
  response.resolve([request()]);
  await flush();
  assert.equal(updates, count);
  assert.deepEqual(f.session.snapshot().requests, []);
  assert.equal(f.c.jobs.filter((x) => x.active).length, 0);
  assert.throws(() => f.session.start());
});
test("다른 계정이나 잘못된 모양의 응답은 표시하지 않는다", async () => {
  for (const row of [
    { ...request(), from: "eve", to: "other" },
    { ...request(), status: "unknown" },
    { ...request(), createdAt: "bad" },
  ]) {
    const f = setup();
    f.readRequests = async () => [row as ChatRequestResponse];
    f.session.start();
    await flush();
    assert.deepEqual(f.session.snapshot().requests, []);
    assert.ok(f.session.snapshot().error);
    f.session.dispose();
  }
});
test("외부에서 반환 스냅샷을 수정해도 내부 요청과 참여자 목록은 바뀌지 않는다", async () => {
  const f = setup();
  f.rooms = [room()];
  f.session.start();
  await flush();
  const value = f.session.snapshot();
  value.rooms[0]!.members[0] = "eve";
  value.requests[0]!.status = "accepted";
  assert.equal(f.session.snapshot().rooms[0]!.members[0], ME);
  assert.equal(f.session.snapshot().requests[0]!.status, "pending");
  f.session.dispose();
});
test("서로 다른 HTTP 로그인 세션에서 새 요청·수락을 관찰하고 같은 방을 연결한다", async () => {
  const f = serverFixture(),
    origin = "https://saju.example";
  const methods: string[] = [];
  const api = createHttpApi({
    service: f.service,
    appOrigin: origin,
    getCurrentUserId: async (req) => req.headers.get("x-test-session"),
  });
  const browser = (userId: string) =>
    createBrowserClient(async (path, init) => {
      methods.push(`${userId} ${init?.method} ${path}`);
      return api(
        new Request(origin + path, {
          ...init,
          headers: { ...init?.headers, origin, "x-test-session": userId },
        }),
      );
    });
  const alice = browser("alice"),
    bob = browser("bob"),
    aClock = clock(),
    bClock = clock();
  const a = createInboxSession({
      userId: "alice",
      client: alice,
      schedule: aClock.schedule,
    }),
    b = createInboxSession({
      userId: "bob",
      client: bob,
      schedule: bClock.schedule,
    });
  a.start();
  b.start();
  await flush();
  const order = await alice.createOrder("a-b");
  if (order.kind !== "payment_required") throw new Error();
  await f.deliver(f.event(order.orderId));
  const invitation = await alice.requestChat(order.orderId);
  await b.refresh(true);
  assert.equal(b.snapshot().requests[0]!.id, invitation.id);
  const { conversationId } = await bob.acceptChat(invitation.id);
  await a.refresh(true);
  assert.deepEqual(
    reconcileInboxSelection(
      { kind: "request", id: invitation.id },
      "alice",
      a.snapshot(),
    ),
    { kind: "room", id: conversationId },
  );
  assert.equal(methods.filter((x) => x.includes("POST /api/orders")).length, 1);
  a.dispose();
  b.dispose();
});

test("갱신 중인 이전 목록이나 일시적 오류는 방금 선택한 방을 삭제한 것으로 취급하지 않는다", async () => {
  const f = setup();
  f.rooms = [room(1)];
  f.session.start();
  await flush();
  const chosen = { kind: "room" as const, id: room(2).id };
  const next = deferred<ConversationResponse[]>();
  f.readRooms = () => next.promise;
  const operation = f.session.refresh(true);
  await flush();
  assert.equal(f.session.snapshot().refreshing, true);
  assert.deepEqual(
    reconcileInboxSelection(chosen, ME, f.session.snapshot()),
    chosen,
  );
  next.resolve([room(1), room(2)]);
  await operation;
  assert.deepEqual(
    reconcileInboxSelection(chosen, ME, f.session.snapshot()),
    chosen,
  );
  f.readRooms = async () => {
    throw new TypeError("offline");
  };
  await f.session.refresh();
  assert.deepEqual(
    reconcileInboxSelection(chosen, ME, f.session.snapshot()),
    chosen,
  );
  f.session.dispose();
});

test("데모 환불 대기 전환이 동시에 진행되는 목록 읽기에 의해 덮어써지지 않는다", async () => {
  const store = createDemoStore();
  const service = createService({
    repository: store.repository,
    gateway: {
      productId: "test",
      checkoutUrl: (ref) => `https://checkout.example/?ref=${ref}`,
      verifyCompleted: async (raw) => JSON.parse(new TextDecoder().decode(raw)),
    },
  });
  const created = await service.createOrder(
    { userId: "demo-me" },
    "match-jiwoo",
  );
  if (created.kind !== "payment_required") throw new Error();
  const entered = deferred<void>(),
    release = deferred<void>();
  const reading = store.repository.transaction(async (tx) => {
    await tx.requestsForUser("demo-me");
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const changing = store.setProfileAvailable("demo-jiwoo", false);
  release.resolve();
  await Promise.all([reading, changing]);
  assert.equal(store.state.active.includes("demo-jiwoo"), false);
  const order = store.state.orders.find((row) => row.id === created.orderId)!;
  const result = await service.paymentWebhook(
    new TextEncoder().encode(
      JSON.stringify({
        reference: order.reference,
        transactionId: "demo-race-payment",
        productId: "test",
        amount: 500,
        currency: "KRW",
      }),
    ),
    new Headers(),
  );
  assert.equal(result.status, "refund_pending");
  assert.equal(store.state.payments.length, 1);
});
