/** Webhook-only absolute budget. A timed-out connection is destroyed, never returned to the pool. */
import type { TransactionPool } from './postgres-repository';

export class PostgresDeadlineError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() { super('Webhook database deadline exceeded'); this.name = 'PostgresDeadlineError'; }
}

export function createDeadlinePool(pool: TransactionPool, timeoutMs = 6500): TransactionPool {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6500)
    throw new Error('Invalid webhook database budget');
  // Monotonic clock: wall-clock changes must not extend a request's budget.
  const deadline = performance.now() + timeoutMs;
  async function bounded<T>(work: () => Promise<T>, cancel?: () => void, disposeLate?: (value: T) => void): Promise<T> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      try { cancel?.(); } catch { /* Preserve the deadline result. */ }
      throw new PostgresDeadlineError();
    }
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const expire = () => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        try { cancel?.(); } catch { /* Cleanup must not replace the timeout result. */ }
        reject(new PostgresDeadlineError());
      };
      const timer = setTimeout(expire, Math.ceil(remaining));
      Promise.resolve().then(() => {
        if (performance.now() >= deadline) { expire(); throw new PostgresDeadlineError(); }
        return work();
      }).then(value => {
        if (!finished && performance.now() >= deadline) expire();
        if (finished) {
          try { disposeLate?.(value); } catch { /* Late checkout cleanup cannot affect the response. */ }
          return;
        }
        finished = true; clearTimeout(timer); resolve(value);
      }, error => {
        if (finished) return;
        finished = true; clearTimeout(timer); reject(error);
      });
    });
  }
  return {
    async connect() {
      const client = await bounded(() => pool.connect(), undefined, late => late.release(true));
      let released = false;
      const release = (discard?: boolean) => {
        if (released) return;
        released = true; client.release(discard);
      };
      // Unit-of-work uses only pg's Promise query form, including BEGIN/COMMIT/ROLLBACK.
      const query = new Proxy(client.query.bind(client), { apply(target, thisArg, args) {
        if (released) return Promise.reject(new PostgresDeadlineError());
        return bounded(() => Reflect.apply(target, thisArg, args), () => release(true));
      }});
      return { query, release };
    },
  };
}
