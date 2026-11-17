/** Server-only. Never import this module from a browser component. */
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Repository } from "../../packages/payment-chat/src/ports.ts";
import { createPostgresTransaction } from "./postgres-transaction";

export interface TransactionPool {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
}
export interface PostgresRepositoryOptions {
  /** Number of retries after the initial attempt; callback must contain awaited DB work only. */
  maxRetries?: number;
  retryDelayMs?: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}
// Only races whose winner can be re-read safely by service.ts. Never retry arbitrary unique errors.
const RACE_CONSTRAINTS = new Set([
  "orders_active_pair_uniq",
  "chat_requests_requester_id_recipient_id_key",
  "conversations_user_a_user_b_key",
  "payments_pkey",
  "payments_order_id_key",
]);
function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, constraint } = error as { code?: string; constraint?: string };
  return (
    code === "40001" ||
    code === "40P01" ||
    (code === "23505" && !!constraint && RACE_CONSTRAINTS.has(constraint))
  );
}
function integer(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${label}`);
  return value;
}

/** One checked-out connection per attempt, including BEGIN, all queries, and COMMIT/ROLLBACK. */
export function createPostgresRepository(
  pool: TransactionPool,
  options: PostgresRepositoryOptions = {},
): Repository {
  const maxRetries = integer(options.maxRetries ?? 5, 0, 10, "maxRetries");
  const delay = integer(options.retryDelayMs ?? 10, 0, 1000, "retryDelayMs");
  const statementTimeout = integer(
    options.statementTimeoutMs ?? 15000,
    1,
    120000,
    "statementTimeoutMs",
  );
  const lockTimeout = integer(
    options.lockTimeoutMs ?? 5000,
    1,
    120000,
    "lockTimeoutMs",
  );
  return {
    async transaction(run) {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        let open = false;
        let active = false;
        let discard = false;
        let canRetry = false;
        let queryFailure: unknown;
        try {
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          open = true;
          await client.query("SET LOCAL ROLE service_role");
          await client.query(
            `select set_config('statement_timeout',$1,true),
            set_config('lock_timeout',$2,true), set_config('idle_in_transaction_session_timeout',$1,true)`,
            [String(statementTimeout), String(lockTimeout)],
          );
          active = true;
          const tx = createPostgresTransaction({
            query: async (sql, params) => {
              if (!active) throw new Error("Transaction is no longer active");
              try {
                return await client.query(sql, params);
              } catch (error) {
                queryFailure = error;
                throw error;
              }
            },
          });
          const result = await run(tx);
          if (queryFailure) throw queryFailure;
          active = false;
          await client.query("COMMIT");
          open = false;
          return result;
        } catch (error) {
          active = false;
          // Connection/unknown COMMIT failures are never replayed: outcome may be ambiguous.
          if (open) {
            try {
              await client.query("ROLLBACK");
            } catch {
              discard = true;
            }
          } else {
            discard = true;
          }
          canRetry = !discard && retryable(error) && attempt < maxRetries;
          if (!canRetry) throw error;
        } finally {
          active = false;
          client.release(discard);
        }
        // Release before backing off so a conflict cannot exhaust the pool.
        if (canRetry && delay)
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(500, delay * 2 ** attempt) +
                Math.floor(Math.random() * delay),
            ),
          );
      }
    },
  };
}

/** Create once per server process; close only during shutdown/tests, never per request. */
export function createPaymentChatDatabase(
  connectionString: string,
  options: {
    pool?: Omit<PoolConfig, "connectionString">;
    repository?: PostgresRepositoryOptions;
  } = {},
) {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
      throw new Error();
  } catch {
    throw new Error("A valid server-only DATABASE_URL is required");
  }
  const pool = new Pool({
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ...options.pool,
    connectionString,
  });
  // Idle connection failures must not become unhandled EventEmitter errors. Never log credentials.
  pool.on("error", () =>
    console.error("PostgreSQL idle connection failed; pool will reconnect"),
  );
  return {
    pool,
    repository: createPostgresRepository(pool, options.repository),
    close: () => pool.end(),
  };
}
