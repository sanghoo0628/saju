import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { startNativePostgres } from "./native-postgres";
import { createPostgresRepository } from "../../src/server/postgres-repository";
import { createService } from "../../packages/payment-chat/src/service.ts";
import { seedUsers, uid } from "../db/harness";
import type {
  CompletedPayment,
  Repository,
} from "../../packages/payment-chat/src/ports.ts";

const ME = uid(1),
  A = uid(10),
  B = uid(11),
  OTHER = uid(99);
let db: Awaited<ReturnType<typeof startNativePostgres>>;
let repository: Repository;
let service: ReturnType<typeof createService>;
let recs: { id: string; target_id: string }[];
const actor = { userId: ME };
const gateway = {
  productId: "chat-one",
  checkoutUrl: (ref: string) => `https://checkout.example/?ref=${ref}`,
  // Production signature verification belongs to the Groble adapter, not the database tests.
  verifyCompleted: async (raw: Uint8Array): Promise<CompletedPayment> =>
    JSON.parse(new TextDecoder().decode(raw)),
};
async function create(target = A) {
  const value = await service.createOrder(
    actor,
    recs.find((r) => r.target_id === target)!.id,
  );
  if (value.kind !== "payment_required") throw new Error("Expected payment");
  return value.orderId;
}
async function deliver(
  orderId: string,
  instance = service,
  transactionId = `pay-${orderId}`,
) {
  const { rows } = await db.pool.query(
    `select reference from orders where id=$1`,
    [orderId],
  );
  const raw = new TextEncoder().encode(
    JSON.stringify({
      reference: rows[0].reference,
      transactionId,
      productId: "chat-one",
      currency: "KRW",
      amount: 500,
    }),
  );
  return instance.paymentWebhook(raw, new Headers());
}
async function paid(target = A) {
  const id = await create(target);
  await deliver(id);
  return id;
}
async function room(target = A) {
  const request = await service.requestChat(actor, await paid(target));
  return (await service.acceptChat({ userId: target }, request.id))
    .conversationId;
}
async function count(
  table: "orders" | "payments" | "chat_requests" | "conversations",
) {
  return (await db.pool.query(`select count(*)::int n from public.${table}`))
    .rows[0].n;
}
beforeAll(async () => {
  db = await startNativePostgres();
  repository = createPostgresRepository(db.pool, {
    retryDelayMs: 0,
    maxRetries: 10,
  });
}, 60000);
afterAll(async () => {
  if (db) await db.close();
}, 30000);
beforeEach(async () => {
  await db.pool
    .query(`truncate public.messages,public.conversations,public.chat_requests,public.payments,
    public.orders,public.match_results,public.profiles,auth.users cascade`);
  await seedUsers(db.pool, [
    { id: ME, score: 3500 },
    { id: A, score: -3490 },
    { id: B, score: -3530 },
    { id: uid(12), score: -3600 },
    { id: OTHER, score: 9999 },
  ]);
  recs = (
    await db.pool.query(
      `select id,target_id from public.get_or_create_match_results($1)`,
      [ME],
    )
  ).rows;
  service = createService({ repository, gateway });
});

describe("native PostgreSQL: production pool + C service + B migrations", () => {
  it("runs on PostgreSQL 18 with different physical connections and restores the local role", async () => {
    expect(
      (await db.pool.query("show server_version")).rows[0].server_version,
    ).toMatch(/^18\./);
    const clients = await Promise.all([db.pool.connect(), db.pool.connect()]);
    try {
      const ids = await Promise.all(
        clients.map((c) => c.query("select pg_backend_pid() pid")),
      );
      expect(new Set(ids.map((r) => r.rows[0].pid)).size).toBe(2);
    } finally {
      clients.forEach((c) => c.release());
    }
    await repository.transaction(async (tx) => {
      expect(await tx.profileAvailable(ME)).toBe(true);
    });
    expect(
      (await db.pool.query("select current_user")).rows[0].current_user,
    ).toBe("postgres");
  });
  it("12 simultaneous clicks produce one pending order", async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => create()));
    expect(new Set(ids).size).toBe(1);
    expect(await count("orders")).toBe(1);
  });
  it("12 simultaneous callbacks settle exactly one payment", async () => {
    const id = await create();
    const responses = await Promise.all(
      Array.from({ length: 12 }, () => deliver(id)),
    );
    expect(responses.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await count("payments")).toBe(1);
    expect((await service.order(actor, id)).status).toBe("fulfilled");
  });
  it("concurrent requests and accepts reuse one request and one room", async () => {
    const id = await paid();
    const requests = await Promise.all(
      Array.from({ length: 8 }, () => service.requestChat(actor, id)),
    );
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
    const accepted = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.acceptChat({ userId: A }, requests[0]!.id),
      ),
    );
    expect(new Set(accepted.map((r) => r.conversationId)).size).toBe(1);
    expect(await count("chat_requests")).toBe(1);
    expect(await count("conversations")).toBe(1);
    expect(await service.createOrder(actor, recs[0]!.id)).toMatchObject({
      kind: "chat_available",
    });
  });
  it("competing opposite-direction accepts converge to the same sorted room", async () => {
    const forward = await service.requestChat(actor, await paid());
    const reverseRec = (
      await db.pool.query(
        `select id,target_id from public.get_or_create_match_results($1)`,
        [A],
      )
    ).rows.find((r) => r.target_id === ME)!;
    const order = await service.createOrder({ userId: A }, reverseRec.id);
    if (order.kind !== "payment_required")
      throw new Error("Expected reverse order");
    await deliver(order.orderId);
    const reverse = await service.requestChat({ userId: A }, order.orderId);
    const accepted = await Promise.all([
      service.acceptChat({ userId: A }, forward.id),
      service.acceptChat(actor, reverse.id),
    ]);
    expect(accepted[0]!.conversationId).toBe(accepted[1]!.conversationId);
    expect(await count("conversations")).toBe(1);
  });
  it("rolls payment insertion back if the same transaction fails before fulfillment", async () => {
    const id = await create();
    const failing: Repository = {
      transaction: (run) =>
        repository.transaction((tx) => {
          const save = tx.savePayment;
          tx.savePayment = async (...args) => {
            await save(...args);
            throw new Error("after-payment");
          };
          return run(tx);
        }),
    };
    await expect(
      deliver(id, createService({ repository: failing, gateway })),
    ).rejects.toThrow("after-payment");
    expect(await count("payments")).toBe(0);
    expect((await service.order(actor, id)).status).toBe("pending");
    await deliver(id);
    expect(await count("payments")).toBe(1);
  });
  it("rejects one transaction ID racing across two different orders", async () => {
    const ids = await Promise.all([create(A), create(B)]);
    const outcomes = await Promise.allSettled(
      ids.map((id) => deliver(id, service, "shared-payment")),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await count("payments")).toBe(1);
    expect(
      (await db.pool.query(`select status from orders order by status`)).rows
        .map((r) => r.status)
        .sort(),
    ).toEqual(["fulfilled", "pending"]);
  });
  it("retains a payment and requires a refund after hard deletion of the target", async () => {
    const id = await create();
    await db.pool.query(`delete from auth.users where id=$1`, [A]);
    expect((await service.order(actor, id)).targetId).toBeNull();
    expect((await deliver(id)).status).toBe("refund_pending");
    expect(await count("payments")).toBe(1);
    await expect(service.requestChat(actor, id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("keeps microsecond cursor precision with 100-row paging and rejects a foreign room cursor", async () => {
    const first = await room(A),
      second = await room(B);
    // UUIDs decrease while sub-millisecond timestamps increase: JS Date-based anchors skip/duplicate these.
    for (let i = 0; i < 105; i++)
      await db.pool.query(
        `insert into messages(id,conversation_id,sender_id,body,created_at)
      values($1,$2,$3,$4,'2026-11-17 00:00:00+00'::timestamptz + $5::int * interval '1 microsecond')`,
        [uid(9000 - i), first, ME, String(i), i],
      );
    const page = await service.messages(actor, first);
    expect(page).toHaveLength(100);
    const next = await service.messages(actor, first, page[99]!.id);
    expect(next.map((m) => m.body)).toEqual([
      "100",
      "101",
      "102",
      "103",
      "104",
    ]);
    await expect(
      service.messages(actor, second, page[0]!.id),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("enforces participant and bidirectional block rules on the privileged connection", async () => {
    const id = await room();
    await service.sendMessage(actor, id, "hello");
    await expect(service.messages({ userId: OTHER }, id)).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await db.pool.query(
      `insert into blocks(blocker_id,blocked_id) values($1,$2)`,
      [A, ME],
    );
    expect(await service.requests(actor)).toEqual([]);
    expect(await service.conversations(actor)).toEqual([]);
    await expect(
      service.sendMessage(actor, id, "blocked"),
    ).rejects.toMatchObject({ code: "BLOCKED" });
  });
});

it('12 concurrent retries of a message produce one row with the production retry defaults', async () => {
  const id=await room();const key=uid(8100);
  const production=createService({repository:createPostgresRepository(db.pool,{retryDelayMs:0}),gateway});
  const results=await Promise.all(Array.from({length:12},()=>production.sendMessage(actor,id,'one logical message',key)));
  expect(results.every(value=>value.id===key&&value.createdAt===results[0]!.createdAt)).toBe(true);
  expect((await db.pool.query('select count(*)::int n from messages where id=$1',[key])).rows[0].n).toBe(1);
});
it('different payloads racing for the same message UUID cannot overwrite each other', async () => {
  const id=await room();const key=uid(8101);
  const results=await Promise.allSettled([
    service.sendMessage(actor,id,'first payload',key),service.sendMessage(actor,id,'second payload',key),
  ]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const failure=results.find(result=>result.status==='rejected');
  expect(failure?.status==='rejected'&&failure.reason.code).toBe('INVALID_REQUEST');
  const rows=(await db.pool.query('select body from messages where id=$1',[key])).rows;
  expect(rows).toHaveLength(1);
  expect(['first payload','second payload']).toContain(rows[0].body);
});
