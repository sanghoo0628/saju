/** Browser-only metadata, never proof of payment. Storage is accessed lazily for SSR compatibility. */
export interface CheckoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export type StoredCheckout =
  | { kind: "found"; orderId: string }
  | { kind: "missing" | "expired" | "invalid" | "unavailable" };
const PREFIX = "saju.checkout-return.v1:";
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function createCheckoutReturnStore(
  options: {
    storage?: () => CheckoutStorage;
    now?: () => number;
    /** Cache lifetime only; does not expire, cancel or refund the actual server order. */
    ttlMs?: number;
  } = {},
) {
  const storage = options.storage ?? (() => window.sessionStorage);
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl <= 0)
    throw new Error("Invalid checkout cache lifetime");
  const key = (userId: string) => PREFIX + userId;
  const discard = (userId: string) => {
    try {
      storage().removeItem(key(userId));
    } catch {
      /* Invalid data stays unusable even if removal fails. */
    }
  };
  return {
    save(
      userId: string,
      orderId: string,
    ): { kind: "saved" | "invalid" | "unavailable" } {
      if (!validId(userId) || !validId(orderId)) return { kind: "invalid" };
      try {
        const savedAt = now();
        if (!validTime(savedAt)) return { kind: "invalid" };
        const value = JSON.stringify({ version: 1, userId, orderId, savedAt });
        const target = storage();
        target.setItem(key(userId), value);
        if (target.getItem(key(userId)) !== value)
          return { kind: "unavailable" };
        return { kind: "saved" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    read(userId: string): StoredCheckout {
      if (!validId(userId)) return { kind: "invalid" };
      let raw: string | null;
      try {
        raw = storage().getItem(key(userId));
      } catch {
        return { kind: "unavailable" };
      }
      if (raw === null) return { kind: "missing" };
      if (raw.length > 1024) {
        discard(userId);
        return { kind: "invalid" };
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        discard(userId);
        return { kind: "invalid" };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        discard(userId);
        return { kind: "invalid" };
      }
      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).length !== 4 ||
        record.version !== 1 ||
        record.userId !== userId ||
        !validId(record.orderId) ||
        !validTime(record.savedAt)
      ) {
        discard(userId);
        return { kind: "invalid" };
      }
      let timestamp: number;
      try {
        timestamp = now();
      } catch {
        return { kind: "unavailable" };
      }
      if (!validTime(timestamp) || record.savedAt > timestamp) {
        discard(userId);
        return { kind: "invalid" };
      }
      if (timestamp - record.savedAt >= ttl) {
        discard(userId);
        return { kind: "expired" };
      }
      return { kind: "found", orderId: record.orderId };
    },
    /** Explicit local cleanup only. An old response must not remove a newer pending checkout. */
    forget(userId: string, expectedOrderId: string): boolean {
      if (!validId(userId) || !validId(expectedOrderId)) return false;
      try {
        const target = storage();
        const raw = target.getItem(key(userId));
        if (!raw) return false;
        const value = JSON.parse(raw) as Record<string, unknown>;
        if (
          !value ||
          value.userId !== userId ||
          value.orderId !== expectedOrderId
        )
          return false;
        target.removeItem(key(userId));
        return target.getItem(key(userId)) === null;
      } catch {
        return false;
      }
    },
  };
}
export type CheckoutReturnStore = ReturnType<typeof createCheckoutReturnStore>;
