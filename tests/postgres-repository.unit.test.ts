import { describe, it, expect, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  createPostgresRepository,
  createPaymentChatDatabase,
  type TransactionPool,
} from "../src/server/postgres-repository";
import type { Transaction } from "../packages/payment-chat/src/ports.ts";

function client(fail?: (sql: string) => unknown) {
  const query = vi.fn(async (sql: string) => {
    const error = fail?.(sql);
    if (error) throw error;
    return { rows: [{ ok: true }], command: sql.split(" ")[0] };
  });
  const release = vi.fn();
  return { query, release };
}
function pool(clients: ReturnType<typeof client>[]) {
  let i = 0;
  const connect = vi.fn(
    async () =>
      clients[Math.min(i++, clients.length - 1)]! as unknown as PoolClient,
  );
  return { connect } satisfies TransactionPool;
}
const serialization = () =>
  Object.assign(new Error("serialization"), { code: "40001" });

describe("PostgreSQL transaction lifecycle", () => {
  it("checks out one client, awaits every query and commit, then releases it", async () => {
    const c = client(),
      p = pool([c]);
    expect(
      await createPostgresRepository(p).transaction(async (tx) =>
        tx.profileAvailable("user"),
      ),
    ).toBe(true);
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(c.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SET LOCAL ROLE service_role",
      expect.stringContaining("statement_timeout"),
      "select private.profile_available($1) ok",
      "COMMIT",
    ]);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("rolls back business errors without retrying", async () => {
    const c = client(),
      p = pool([c]),
      error = new Error("business");
    await expect(
      createPostgresRepository(p).transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(p.connect).toHaveBeenCalledTimes(1);
    expect(c.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(c.release).toHaveBeenCalledWith(false);
  });
  it.each(["40001", "40P01"])(
    "replays the complete callback after %s, releasing first",
    async (code) => {
      const first = client(),
        second = client(),
        p = pool([first, second]);
      let calls = 0;
      const result = await createPostgresRepository(p, {
        retryDelayMs: 0,
      }).transaction(async (tx) => {
        await tx.profileAvailable("user");
        if (++calls === 1) throw Object.assign(new Error(), { code });
        expect(first.release).toHaveBeenCalledWith(false);
        return "committed";
      });
      expect(result).toBe("committed");
      expect(calls).toBe(2);
      expect(first.query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(second.query).toHaveBeenLastCalledWith("COMMIT");
    },
  );
  it.each(["orders_active_pair_uniq", "messages_pkey"])("retries recognized %s races, not arbitrary unique constraints", async (constraint) => {
    const first = client(),
      second = client(),
      p = pool([first, second]);
    let calls = 0;
    await createPostgresRepository(p, { retryDelayMs: 0 }).transaction(
      async () => {
        if (++calls === 1)
          throw { code: "23505", constraint };
      },
    );
    expect(calls).toBe(2);
    const unknown = pool([client()]);
    await expect(
      createPostgresRepository(unknown).transaction(async () => {
        throw { code: "23505", constraint: "orders_reference_key" };
      }),
    ).rejects.toMatchObject({ code: "23505" });
    expect(unknown.connect).toHaveBeenCalledTimes(1);
  });
  it("stops retries at the configured limit", async () => {
    const p = pool([client()]),
      run = vi.fn(async () => {
        throw serialization();
      });
    await expect(
      createPostgresRepository(p, {
        maxRetries: 2,
        retryDelayMs: 0,
      }).transaction(run),
    ).rejects.toThrow("serialization");
    expect(run).toHaveBeenCalledTimes(3);
    expect(p.connect).toHaveBeenCalledTimes(3);
  });
  it("retries a serialization error returned by COMMIT", async () => {
    const p = pool([
      client((sql) => (sql === "COMMIT" ? serialization() : undefined)),
      client(),
    ]);
    const run = vi.fn(async () => "ok");
    expect(
      await createPostgresRepository(p, { retryDelayMs: 0 }).transaction(run),
    ).toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("never replays a COMMIT with an ambiguous connection failure", async () => {
    const c = client((sql) =>
        sql === "COMMIT" ? { code: "ECONNRESET" } : undefined,
      ),
      p = pool([c]);
    const run = vi.fn(async () => undefined);
    await expect(
      createPostgresRepository(p).transaction(run),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("destroys the connection when rollback fails and preserves the original error", async () => {
    const c = client((sql) =>
        sql === "ROLLBACK" ? new Error("rollback") : undefined,
      ),
      p = pool([c]);
    const error = serialization();
    await expect(
      createPostgresRepository(p).transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(c.release).toHaveBeenCalledWith(true);
    expect(p.connect).toHaveBeenCalledTimes(1);
  });
  it("destroys a client whose BEGIN failed", async () => {
    const c = client((sql) =>
      sql.startsWith("BEGIN") ? new Error("begin") : undefined,
    );
    await expect(
      createPostgresRepository(pool([c])).transaction(async () => undefined),
    ).rejects.toThrow("begin");
    expect(c.release).toHaveBeenCalledWith(true);
  });
  it("does not use a transaction after its callback completed", async () => {
    const c = client();
    let leaked: Transaction | undefined;
    await createPostgresRepository(pool([c])).transaction(async (tx) => {
      leaked = tx;
    });
    const n = c.query.mock.calls.length;
    await expect(leaked!.profileAvailable("user")).rejects.toThrow(
      "no longer active",
    );
    expect(c.query).toHaveBeenCalledTimes(n);
  });
  it("does not report success after the callback swallowed a failed SQL statement", async () => {
    const error = Object.assign(new Error("foreign key"), { code: "23503" });
    const c = client((sql) =>
      sql.startsWith("select private.") ? error : undefined,
    );
    await expect(
      createPostgresRepository(pool([c])).transaction(async (tx) => {
        await tx.profileAvailable("user").catch(() => false);
      }),
    ).rejects.toBe(error);
    expect(c.query).toHaveBeenLastCalledWith("ROLLBACK");
  });
  it("rejects invalid configuration without including the supplied secret", () => {
    expect(() =>
      createPostgresRepository(pool([client()]), { maxRetries: -1 }),
    ).toThrow("Invalid maxRetries");
    expect(() =>
      createPaymentChatDatabase("https://secret@example.com"),
    ).toThrow("A valid server-only DATABASE_URL is required");
  });
});
