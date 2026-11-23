/** PGlite migration tests execute the production SQL mapping. */
import type { Repository } from "../../packages/payment-chat/src/ports.ts";
import { createPostgresTransaction } from "../../src/server/postgres-transaction";
import type { TestDb } from "../db/harness";
export function createSqlProofRepository(
  db: TestDb,
  options: { failAfterPayment?: boolean } = {},
): Repository {
  return {
    transaction: (run) =>
      db.asService((q) => {
        const tx = createPostgresTransaction(q);
        if (options.failAfterPayment) {
          const save = tx.savePayment;
          tx.savePayment = async (...args) => {
            await save(...args);
            throw new Error("INJECTED_AFTER_PAYMENT");
          };
        }
        return run(tx);
      }),
  };
}
