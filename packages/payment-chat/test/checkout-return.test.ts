import { createHttpApi } from "../src/http.ts";
import { fixture as serverFixture } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCheckoutReturnStore,
  type CheckoutStorage,
} from "../src/checkout-return-store.ts";
import { createCheckoutReturnController } from "../src/checkout-return.ts";
import { createCheckoutFlow } from "../src/checkout-flow.ts";
import { PaymentChatClientError, createBrowserClient } from "../src/client.ts";
import type { OrderResponse } from "../../../contracts/payment-chat.ts";

type Client = Pick<
  ReturnType<typeof createBrowserClient>,
  "createOrder" | "order"
>;
const NOW = 1800000000000;
const USER = "user-a",
  OTHER = "user-b",
  ORDER = "order-1";
const URL = "https://pay.example/checkout?ref=server-reference";
const key = (userId = USER) => `saju.checkout-return.v1:${userId}`;
function memory() {
  const values = new Map<string, string>();
  const storage: CheckoutStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => {
      values.set(k, v);
    },
    removeItem: (k) => {
      values.delete(k);
    },
  };
  return { values, storage };
}
function fixture(
  options: {
    userId?: string;
    storage?: CheckoutStorage;
    order?: Client["order"];
    navigate?: (url: string) => void;
    checkoutUrl?: string;
  } = {},
) {
  const mem = memory();
  const store = createCheckoutReturnStore({
    storage: () => options.storage ?? mem.storage,
    now: () => NOW,
  });
  let creates = 0,
    reads = 0,
    navigations = 0;
  const client: Client = {
    createOrder: async () => {
      creates++;
      return {
        kind: "payment_required",
        orderId: ORDER,
        amountKrw: 500,
        checkoutUrl: options.checkoutUrl ?? URL,
      };
    },
    order: async (...args) => {
      reads++;
      return options.order
        ? options.order(...args)
        : { orderId: ORDER, status: "fulfilled", targetId: "peer" };
    },
  };
  const flow = createCheckoutFlow({ client, maxAttempts: 1 });
  const controller = createCheckoutReturnController({
    userId: options.userId ?? USER,
    flow,
    store,
    allowedCheckoutOrigins: ["https://pay.example"],
    navigate: (url) => {
      navigations++;
      options.navigate?.(url);
    },
  });
  return {
    ...mem,
    store,
    flow,
    controller,
    client,
    counts: () => ({ creates, reads, navigations }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("복귀 저장소는 계정별 최소 메타데이터만 저장하고 다른 계정에는 보이지 않는다", () => {
  const { storage, values } = memory();
  const store = createCheckoutReturnStore({
    storage: () => storage,
    now: () => NOW,
  });
  assert.deepEqual(store.save(USER, ORDER), { kind: "saved" });
  assert.deepEqual(JSON.parse(values.get(key())!), {
    version: 1,
    userId: USER,
    orderId: ORDER,
    savedAt: NOW,
  });
  assert.deepEqual(store.read(USER), { kind: "found", orderId: ORDER });
  assert.deepEqual(store.read(OTHER), { kind: "missing" });
});

test("잘못된 JSON·다른 계정·위조 상태·잘못된 ID·과도한 데이터는 조회 대상으로 사용하지 않는다", () => {
  const { storage, values } = memory();
  const store = createCheckoutReturnStore({
    storage: () => storage,
    now: () => NOW,
  });
  const valid = { version: 1, userId: USER, orderId: ORDER, savedAt: NOW };
  for (const raw of [
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...valid, userId: OTHER }),
    JSON.stringify({ ...valid, status: "fulfilled" }),
    JSON.stringify({ ...valid, orderId: "../other" }),
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, savedAt: "yesterday" }),
    "x".repeat(1025),
  ]) {
    values.set(key(), raw);
    assert.deepEqual(store.read(USER), { kind: "invalid" });
    assert.equal(values.has(key()), false);
  }
});

test("캐시 만료와 미래 시각은 유효한 주문 정보로 복구하지 않고 다른 사용자의 캐시는 보존한다", () => {
  const { storage, values } = memory();
  let clock = NOW;
  const store = createCheckoutReturnStore({
    storage: () => storage,
    now: () => clock,
    ttlMs: 100,
  });
  store.save(USER, ORDER);
  store.save(OTHER, "other-order");
  clock += 100;
  assert.deepEqual(store.read(USER), { kind: "expired" });
  assert.ok(values.has(key(OTHER)));
  clock = NOW;
  store.save(USER, ORDER);
  clock--;
  assert.deepEqual(store.read(USER), { kind: "invalid" });
});

test("저장소 획득·조회·쓰기 실패는 예외 대신 unavailable이며 저장 실패 시 이동하지 않는다", async () => {
  const unavailable = createCheckoutReturnStore({
    storage: () => {
      throw new Error("blocked");
    },
  });
  assert.deepEqual(unavailable.read(USER), { kind: "unavailable" });
  assert.deepEqual(unavailable.save(USER, ORDER), { kind: "unavailable" });
  for (const storage of [
    {
      getItem: () => {
        throw new Error("read");
      },
      setItem: () => {},
      removeItem: () => {},
    },
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    },
    { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  ]) {
    const f = fixture({ storage });
    await f.flow.start("match");
    assert.deepEqual(f.controller.leave(), { kind: "storage_unavailable" });
    assert.equal(f.counts().navigations, 0);
  }
});

test("이전 주문의 정리 콜백은 같은 계정의 새 주문이나 다른 계정의 정보를 삭제하지 않는다", () => {
  const f = fixture();
  f.store.save(USER, ORDER);
  f.store.save(OTHER, "other-order");
  f.store.save(USER, "new-order");
  assert.equal(f.controller.forget(ORDER), false);
  assert.deepEqual(f.store.read(USER), { kind: "found", orderId: "new-order" });
  assert.equal(f.controller.forget("new-order"), true);
  assert.deepEqual(f.store.read(OTHER), {
    kind: "found",
    orderId: "other-order",
  });
});

test("명시적인 결제 버튼에서 저장을 먼저 완료하고 같은 주문으로 한 번만 이동한다", async () => {
  const f = fixture({
    navigate: (url) => {
      assert.equal(url, URL);
      assert.deepEqual(f.store.read(USER), { kind: "found", orderId: ORDER });
    },
  });
  assert.deepEqual(f.counts(), { creates: 0, reads: 0, navigations: 0 });
  await f.flow.start("match");
  assert.deepEqual(f.controller.leave(), {
    kind: "redirect_requested",
    orderId: ORDER,
  });
  assert.deepEqual(f.controller.leave(), {
    kind: "redirect_requested",
    orderId: ORDER,
  });
  assert.deepEqual(f.counts(), { creates: 1, reads: 0, navigations: 1 });
});

test("새 페이지의 복귀는 저장된 같은 주문을 GET으로만 확인한다", async () => {
  const first = fixture();
  await first.flow.start("match");
  first.controller.leave();
  first.controller.dispose();
  assert.deepEqual(first.store.read(USER), { kind: "found", orderId: ORDER });
  const returned = fixture({ storage: first.storage });
  const result = await returned.controller.restore();
  assert.deepEqual(result, {
    kind: "restored",
    orderId: ORDER,
    state: { kind: "chat_available", orderId: ORDER },
  });
  assert.deepEqual(returned.counts(), { creates: 0, reads: 1, navigations: 0 });
  // Keep recovery possible until the UI explicitly acknowledges the result.
  assert.deepEqual(returned.store.read(USER), {
    kind: "found",
    orderId: ORDER,
  });
});

test("다른 계정으로 돌아오면 원래 사용자의 주문 API를 호출하지 않는다", async () => {
  const first = fixture();
  first.store.save(USER, ORDER);
  const other = fixture({ userId: OTHER, storage: first.storage });
  assert.deepEqual(await other.controller.restore(), { kind: "missing" });
  assert.deepEqual(other.counts(), { creates: 0, reads: 0, navigations: 0 });
});

test("만료·깨진 저장 정보와 저장소 장애는 복귀 시 네트워크 요청을 만들지 않는다", async () => {
  const f = fixture();
  f.values.set(
    key(),
    JSON.stringify({ version: 1, userId: USER, orderId: ORDER, savedAt: 0 }),
  );
  assert.deepEqual(await f.controller.restore(), { kind: "expired" });
  f.values.set(key(), "bad");
  assert.deepEqual(await f.controller.restore(), { kind: "invalid" });
  assert.equal(f.counts().reads, 0);
  const bad = fixture({
    storage: {
      getItem: () => {
        throw new Error();
      },
      setItem: () => {},
      removeItem: () => {},
    },
  });
  assert.deepEqual(await bad.controller.restore(), { kind: "unavailable" });
  assert.equal(bad.counts().reads, 0);
});

test("대기·환불 대기·환불 완료·취소는 저장 정보만으로 결제 성공이 되지 않는다", async () => {
  for (const status of [
    "pending",
    "refund_pending",
    "refunded",
    "cancelled",
  ] as const) {
    const f = fixture({
      order: async () => ({ orderId: ORDER, status, targetId: "peer" }),
    });
    f.store.save(USER, ORDER);
    const result = await f.controller.restore();
    assert.equal(result.kind, "restored");
    assert.equal(
      f.flow.snapshot().kind,
      status === "pending" ? "confirmation_pending" : status,
    );
    assert.equal(f.counts().creates, 0);
    assert.equal(f.counts().navigations, 0);
  }
});

test("서버가 다른 주문을 응답하면 권한을 만들지 않고 원래 주문 번호를 유지한다", async () => {
  const f = fixture({
    order: async () => ({
      orderId: "other-order",
      status: "fulfilled",
      targetId: "peer",
    }),
  });
  f.store.save(USER, ORDER);
  await f.controller.restore();
  assert.deepEqual(f.flow.snapshot(), {
    kind: "confirmation_pending",
    orderId: ORDER,
  });
});

test("변조된 주문은 서버의 소유권 검사에서 거부되며 새 주문·자동 재결제로 우회하지 않는다", async () => {
  const f = fixture({
    order: async () => {
      throw new PaymentChatClientError("FORBIDDEN", "접근할 수 없습니다.", 403);
    },
  });
  f.store.save(USER, "forged-order");
  const result = await f.controller.restore();
  assert.equal(result.kind, "restored");
  assert.equal(f.flow.snapshot().kind, "error");
  assert.deepEqual(f.counts(), { creates: 0, reads: 1, navigations: 0 });
});

test("일시적 서버 장애 뒤에도 같은 주문으로 재확인할 수 있다", async () => {
  let available = false;
  const f = fixture({
    order: async () => {
      if (!available)
        throw new PaymentChatClientError(
          "PROVIDER_UNAVAILABLE",
          "일시 장애",
          503,
        );
      return { orderId: ORDER, status: "fulfilled", targetId: "peer" };
    },
  });
  f.store.save(USER, ORDER);
  await f.controller.restore();
  assert.equal(f.flow.snapshot().kind, "confirmation_pending");
  available = true;
  await f.controller.restore();
  assert.deepEqual(f.flow.snapshot(), {
    kind: "chat_available",
    orderId: ORDER,
  });
  assert.deepEqual(f.counts(), { creates: 0, reads: 2, navigations: 0 });
});

test("복귀 중복 호출은 하나의 조회 작업을 공유한다", async () => {
  const response = deferred<OrderResponse>();
  const f = fixture({ order: async () => response.promise });
  f.store.save(USER, ORDER);
  const first = f.controller.restore(),
    second = f.controller.restore();
  assert.equal(first, second);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.counts().reads, 1);
  response.resolve({ orderId: ORDER, status: "fulfilled", targetId: "peer" });
  await first;
});

test("복귀 조회 도중 계정/화면이 해제되면 늦은 완료 응답을 적용하지 않는다", async () => {
  const response = deferred<OrderResponse>();
  const f = fixture({ order: async () => response.promise });
  f.store.save(USER, ORDER);
  const operation = f.controller.restore();
  await Promise.resolve();
  await Promise.resolve();
  f.controller.dispose();
  response.resolve({ orderId: ORDER, status: "fulfilled", targetId: "peer" });
  assert.deepEqual(await operation, { kind: "disposed" });
  assert.deepEqual(f.flow.snapshot(), { kind: "idle" });
  assert.deepEqual(f.controller.leave(), { kind: "disposed" });
  assert.deepEqual(await f.controller.restore(), { kind: "disposed" });
  assert.deepEqual(f.store.read(USER), { kind: "found", orderId: ORDER });
});

test("복귀 직후 바로 해제하면 아직 시작하지 않은 조회도 실행하지 않는다", async () => {
  const f = fixture();
  f.store.save(USER, ORDER);
  const operation = f.controller.restore();
  f.controller.dispose();
  assert.deepEqual(await operation, { kind: "disposed" });
  assert.equal(f.counts().reads, 0);
});

test("허용되지 않은 출처·HTTP·사용자정보가 있는 주소로는 이동하거나 저장하지 않는다", () => {
  for (const checkoutUrl of [
    "https://pay.example.evil/",
    "http://pay.example/",
    "https://pay.example@evil.example/",
    "https://user:password@pay.example/",
    "javascript:alert(1)",
    "/relative",
  ]) {
    const f = fixture();
    const controller = createCheckoutReturnController({
      userId: USER,
      store: f.store,
      flow: {
        snapshot: () => ({
          kind: "payment_required",
          orderId: ORDER,
          amountKrw: 500,
          checkoutUrl,
        }),
        resume: async () => {},
        reset: () => {},
      },
      allowedCheckoutOrigins: ["https://pay.example"],
      navigate: () => assert.fail("must not navigate"),
    });
    assert.deepEqual(controller.leave(), { kind: "invalid_url" });
    assert.deepEqual(f.store.read(USER), { kind: "missing" });
  }
});

test("이동 요청 자체가 실패해도 저장된 주문을 보존하고 같은 주문으로 재시도한다", async () => {
  let broken = true;
  const f = fixture({
    navigate: () => {
      if (broken) throw new Error("navigation blocked");
    },
  });
  await f.flow.start("match");
  assert.deepEqual(f.controller.leave(), {
    kind: "navigation_failed",
    orderId: ORDER,
  });
  assert.deepEqual(f.store.read(USER), { kind: "found", orderId: ORDER });
  broken = false;
  assert.deepEqual(f.controller.leave(), {
    kind: "redirect_requested",
    orderId: ORDER,
  });
  assert.equal(f.counts().creates, 1);
});

test("결제 준비 상태가 아니면 자동 이동하지 않으며 설정 오류는 조기에 거부한다", () => {
  const f = fixture();
  assert.deepEqual(f.controller.leave(), { kind: "not_ready" });
  for (const allowedCheckoutOrigins of [
    [],
    ["http://pay.example"],
    ["https://pay.example/path"],
    ["https://user@pay.example"],
  ])
    assert.throws(() =>
      createCheckoutReturnController({
        userId: USER,
        flow: f.flow,
        store: f.store,
        allowedCheckoutOrigins,
      }),
    );
  assert.throws(() =>
    createCheckoutReturnController({
      userId: "",
      flow: f.flow,
      store: f.store,
      allowedCheckoutOrigins: ["https://pay.example"],
    }),
  );
  assert.throws(() => createCheckoutReturnStore({ ttlMs: 0 }));
});

test("서버 렌더링 환경에서도 브라우저 저장소에 접근하지 않고 모듈을 구성할 수 있다", async () => {
  const store = createCheckoutReturnStore();
  const f = fixture();
  const controller = createCheckoutReturnController({
    userId: USER,
    flow: f.flow,
    store,
    allowedCheckoutOrigins: ["https://pay.example"],
  });
  assert.deepEqual(await controller.restore(), { kind: "unavailable" });
  assert.deepEqual(f.counts(), { creates: 0, reads: 0, navigations: 0 });
});

test("복귀 조회 도중 새 결제 준비를 선택하면 이전 복귀 결과를 새 화면에 연결하지 않는다", async () => {
  const response = deferred<OrderResponse>();
  const f = fixture({ order: async () => response.promise });
  f.store.save(USER, ORDER);
  const operation = f.controller.restore();
  await Promise.resolve();
  await Promise.resolve();
  // Even reselecting the same pending order must supersede the old return operation.
  await f.flow.start("match");
  response.resolve({ orderId: ORDER, status: "fulfilled", targetId: "peer" });
  assert.deepEqual(await operation, { kind: "superseded" });
  assert.equal(f.flow.snapshot().kind, "payment_required");
  assert.equal(f.counts().navigations, 0);
});

test("HTTP 클라이언트·주문 서비스와 연결해 결제 후 복귀하고 다른 세션의 주문 복구를 거부한다", async () => {
  const server = serverFixture(),
    appOrigin = "https://saju.example";
  const requests: { userId: string; method: string; path: string }[] = [];
  const api = createHttpApi({
    service: server.service,
    appOrigin,
    getCurrentUserId: async (req) => req.headers.get("x-test-session"),
  });
  const browser = (userId: string) =>
    createBrowserClient(async (path, init) => {
      requests.push({
        userId,
        method: init?.method ?? "GET",
        path: String(path),
      });
      return api(
        new Request(appOrigin + path, {
          ...init,
          headers: {
            ...init?.headers,
            origin: appOrigin,
            "x-test-session": userId,
          },
        }),
      );
    });
  const mem = memory();
  const store = createCheckoutReturnStore({
    storage: () => mem.storage,
    now: () => NOW,
  });
  const client = browser("alice"),
    flow = createCheckoutFlow({ client, maxAttempts: 1 });
  const make = (
    userId: string,
    instance: ReturnType<typeof createCheckoutFlow>,
  ) =>
    createCheckoutReturnController({
      userId,
      flow: instance,
      store,
      allowedCheckoutOrigins: ["https://example.invalid"],
      navigate: () => {},
    });
  const leaving = make("alice", flow);
  await flow.start("a-b");
  const started = flow.snapshot();
  assert.equal(started.kind, "payment_required");
  if (started.kind !== "payment_required") throw new Error("Expected order");
  assert.equal(leaving.leave().kind, "redirect_requested");
  leaving.dispose();
  await server.deliver(server.event(started.orderId));
  const returnedFlow = createCheckoutFlow({ client, maxAttempts: 1 });
  const returning = make("alice", returnedFlow);
  const checkpoint = requests.length;
  assert.equal((await returning.restore()).kind, "restored");
  assert.deepEqual(returnedFlow.snapshot(), {
    kind: "chat_available",
    orderId: started.orderId,
  });
  assert.deepEqual(requests.slice(checkpoint), [
    { userId: "alice", method: "GET", path: `/api/orders/${started.orderId}` },
  ]);
  // Even a valid-looking cache forged for another signed-in user cannot grant their chat access.
  store.save("bob", started.orderId);
  const foreignFlow = createCheckoutFlow({
    client: browser("bob"),
    maxAttempts: 1,
  });
  await make("bob", foreignFlow).restore();
  assert.equal(foreignFlow.snapshot().kind, "error");
  assert.equal(
    requests.filter((r) => r.method === "POST" && r.path === "/api/orders")
      .length,
    1,
  );
});
