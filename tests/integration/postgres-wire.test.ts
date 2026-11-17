/** Actual pg.Pool TCP/protocol integration against PGlite; not native multi-backend concurrency. */
import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  createTestDb,
  seedUsers,
  recommend,
  uid,
  type TestDb,
  type Recommendation,
} from "../db/harness";
import { createPaymentChatDatabase } from "../../src/server/postgres-repository";
import { createService } from "../../packages/payment-chat/src/service.ts";
import { createHttpApi } from "../../packages/payment-chat/src/http.ts";
import type {
  CompletedPayment,
  Repository,
} from "../../packages/payment-chat/src/ports.ts";

let t: TestDb,
  socket: PGLiteSocketServer,
  database: ReturnType<typeof createPaymentChatDatabase>;
let service: ReturnType<typeof createService>, recs: Recommendation[];
const ME = uid(1),
  A = uid(10),
  B = uid(11),
  C = uid(12),
  OTHER = uid(99),
  actor = { userId: ME };
const gateway = {
  productId: "chat-one",
  checkoutUrl: (ref: string) => `https://checkout.example/?ref=${ref}`,
  verifyCompleted: async (raw: Uint8Array): Promise<CompletedPayment> =>
    JSON.parse(new TextDecoder().decode(raw)),
};
async function create(target = A) {
  const result = await service.createOrder(
    actor,
    recs.find((r) => r.target_id === target)!.id,
  );
  if (result.kind !== "payment_required") throw new Error("Expected order");
  return result.orderId;
}
async function deliver(orderId: string, instance = service) {
  const row = (
    await t.db.query<{ reference: string }>(
      `select reference from orders where id=$1`,
      [orderId],
    )
  ).rows[0]!;
  return instance.paymentWebhook(
    new TextEncoder().encode(
      JSON.stringify({
        reference: row.reference,
        transactionId: `pay-${orderId}`,
        productId: "chat-one",
        currency: "KRW",
        amount: 500,
      }),
    ),
    new Headers(),
  );
}
async function room(target = A) {
  const id = await create(target);
  await deliver(id);
  const request = await service.requestChat(actor, id);
  return (await service.acceptChat({ userId: target }, request.id))
    .conversationId;
}
beforeAll(async () => {
  t = await createTestDb();
  socket = new PGLiteSocketServer({
    db: t.db,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 1,
  });
  await socket.start();
  database = createPaymentChatDatabase(
    `postgresql://postgres@${socket.getServerConn()}/postgres`,
    { pool: { max: 1 }, repository: { retryDelayMs: 0 } },
  );
}, 30000);
afterAll(async () => {
  if (database) await database.close();
  if (socket) await socket.stop();
  if (t) await t.db.close();
});
beforeEach(async () => {
  await t.db
    .exec(`truncate public.messages,public.conversations,public.chat_requests,public.payments,
    public.orders,public.match_results,public.profiles,auth.users cascade`);
  await seedUsers(t.db, [
    { id: ME, score: 3500 },
    { id: A, score: -3490 },
    { id: B, score: -3530 },
    { id: C, score: -3600 },
    { id: OTHER, score: 9999 },
  ]);
  recs = await recommend(t, ME);
  service = createService({ repository: database.repository, gateway });
});
it("serves order → callback → request → accept → both-way messages over a real pg TCP connection", async () => {
  const origin = "https://saju.test";
  const api = createHttpApi({
    service,
    appOrigin: origin,
    getCurrentUserId: async (req) => req.headers.get("x-test-user"),
  });
  const post = async (path: string, user: string, body: unknown) => {
    const res = await api(
      new Request(origin + path, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-test-user": user,
        },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    return res.json();
  };
  const order = await post("/api/orders", ME, { matchResultId: recs[0]!.id });
  expect((await service.order(actor, order.orderId)).status).toBe("pending");
  await deliver(order.orderId);
  const request = await post("/api/chat-requests", ME, {
    orderId: order.orderId,
  });
  const accepted = await post(`/api/chat-requests/${request.id}/accept`, A, {});
  await service.sendMessage(actor, accepted.conversationId, "안녕");
  await service.sendMessage({ userId: A }, accepted.conversationId, "반가워");
  expect(
    (await service.messages(actor, accepted.conversationId)).map((m) => m.body),
  ).toEqual(["안녕", "반가워"]);
  expect((await service.requests(actor))[0]).toMatchObject({
    status: "accepted",
    from: ME,
    to: A,
  });
  expect((await service.conversations(actor))[0]!.members).toEqual([ME, A]);
  expect(
    (await database.pool.query("select current_user")).rows[0].current_user,
  ).toBe("postgres");
});
it("rolls back payment + status through pg and leaves the pooled connection reusable", async () => {
  const id = await create();
  const failing: Repository = {
    transaction: (run) =>
      database.repository.transaction((tx) => {
        const save = tx.savePayment;
        tx.savePayment = async (...args) => {
          await save(...args);
          throw new Error("injected");
        };
        return run(tx);
      }),
  };
  await expect(
    deliver(id, createService({ repository: failing, gateway })),
  ).rejects.toThrow("injected");
  expect(
    (await database.pool.query("select count(*)::int n from payments")).rows[0]
      .n,
  ).toBe(0);
  expect((await service.order(actor, id)).status).toBe("pending");
  await deliver(id);
  await deliver(id);
  expect(
    (await database.pool.query("select count(*)::int n from payments")).rows[0]
      .n,
  ).toBe(1);
});
it("uses database-precision message anchors and enforces room scope", async () => {
  const one = await room(A),
    two = await room(B);
  await t.db.query(
    `insert into messages(id,conversation_id,sender_id,body,created_at)
    select ('00000000-0000-4000-8000-' || lpad((9000-i)::text,12,'0'))::uuid,$1,$2,i::text,
    '2026-11-17 00:00:00+00'::timestamptz + i * interval '1 microsecond' from generate_series(0,104) i`,
    [one, ME],
  );
  const first = await service.messages(actor, one);
  expect(first).toHaveLength(100);
  expect(
    (await service.messages(actor, one, first[99]!.id)).map((m) => m.body),
  ).toEqual(["100", "101", "102", "103", "104"]);
  await expect(
    service.messages(actor, two, first[0]!.id),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
it("paginates descending requests/rooms with microsecond precision and rejects foreign cursors", async () => {
  const rooms = [await room(A), await room(B), await room(C)];
  const requests = await service.requests(actor);
  for (let i = 0; i < 3; i++) {
    await t.db.query(
      `update conversations set created_at='2026-11-17 00:00:00+00'::timestamptz + $2::int * interval '1 microsecond' where id=$1`,
      [rooms[i], i],
    );
    await t.db.query(
      `update chat_requests set created_at='2026-11-17 00:00:00+00'::timestamptz + $2::int * interval '1 microsecond' where id=$1`,
      [requests[i]!.id, i],
    );
  }
  expect(
    (await service.conversations(actor, rooms[2])).map((r) => r.id),
  ).toEqual([rooms[1], rooms[0]]);
  expect(
    (await service.requests(actor, requests[2]!.id)).map((r) => r.id),
  ).toEqual([requests[1]!.id, requests[0]!.id]);
  await expect(
    service.conversations({ userId: OTHER }, rooms[0]),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(
    service.requests({ userId: OTHER }, requests[0]!.id),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
});
it("preserves payment evidence and returns refund_pending for a deleted target", async () => {
  const id = await create();
  await t.db.query(`delete from auth.users where id=$1`, [A]);
  expect((await deliver(id)).status).toBe("refund_pending");
  expect((await service.order(actor, id)).targetId).toBeNull();
  await expect(service.requestChat(actor, id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it("applies membership and reverse-direction blocks on privileged queries", async () => {
  const id = await room();
  await expect(service.messages({ userId: OTHER }, id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await t.db.query(`insert into blocks(blocker_id,blocked_id) values($1,$2)`, [
    A,
    ME,
  ]);
  expect(await service.requests(actor)).toEqual([]);
  expect(await service.conversations(actor)).toEqual([]);
  await expect(service.sendMessage(actor, id, "blocked")).rejects.toMatchObject(
    { code: "BLOCKED" },
  );
});
