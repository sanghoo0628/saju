import type { CheckoutState, createCheckoutFlow } from "./checkout-flow.ts";
import type { CheckoutReturnStore } from "./checkout-return-store.ts";

type Flow = Pick<
  ReturnType<typeof createCheckoutFlow>,
  "snapshot" | "resume" | "reset"
>;
export type CheckoutLeaveResult =
  | { kind: "redirect_requested"; orderId: string }
  | { kind: "navigation_failed"; orderId: string }
  | { kind: "not_ready" | "invalid_url" | "storage_unavailable" | "disposed" };
export type CheckoutRestoreResult =
  | { kind: "restored"; orderId: string; state: CheckoutState }
  | {
      kind:
        | "missing"
        | "expired"
        | "invalid"
        | "unavailable"
        | "superseded"
        | "disposed"
        | "error";
    };

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("Checkout origins must be explicit HTTPS origins");
  }
}

/**
 * Construct once per authenticated user. Calls no API and performs no navigation on construction.
 * leave() is for an explicit payment button; restore() only performs existing-order GETs via flow.resume().
 * Return URL flags, storage fields and navigation success never grant chat access.
 */
export function createCheckoutReturnController(options: {
  userId: string;
  flow: Flow;
  store: CheckoutReturnStore;
  allowedCheckoutOrigins: readonly string[];
  navigate?: (url: string) => void;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.userId))
    throw new Error("Authenticated user ID is required");
  const allowed = new Set(options.allowedCheckoutOrigins.map(origin));
  if (!allowed.size)
    throw new Error("At least one checkout origin is required");
  const navigate = options.navigate ?? ((url) => window.location.assign(url));
  let disposed = false;
  let generation = 0;
  let redirect: { orderId: string; url: string } | undefined;
  let restoring: Promise<CheckoutRestoreResult> | undefined;
  return {
    leave(): CheckoutLeaveResult {
      if (disposed) return { kind: "disposed" };
      const state = options.flow.snapshot();
      if (state.kind !== "payment_required") return { kind: "not_ready" };
      let url: URL;
      try {
        url = new URL(state.checkoutUrl);
      } catch {
        return { kind: "invalid_url" };
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !allowed.has(url.origin)
      )
        return { kind: "invalid_url" };
      if (redirect?.orderId === state.orderId && redirect.url === url.href)
        return { kind: "redirect_requested", orderId: state.orderId };
      if (options.store.save(options.userId, state.orderId).kind !== "saved")
        return { kind: "storage_unavailable" };
      generation++;
      redirect = { orderId: state.orderId, url: url.href };
      try {
        navigate(url.href);
        return { kind: "redirect_requested", orderId: state.orderId };
      } catch {
        redirect = undefined;
        // Keep the record so the same order can be retried/verified. Never create a replacement order here.
        return { kind: "navigation_failed", orderId: state.orderId };
      }
    },
    restore(): Promise<CheckoutRestoreResult> {
      if (disposed) return Promise.resolve({ kind: "disposed" });
      if (restoring) return restoring;
      redirect = undefined;
      const token = ++generation;
      const operation = Promise.resolve().then(
        async (): Promise<CheckoutRestoreResult> => {
          if (disposed) return { kind: "disposed" };
          if (token !== generation) return { kind: "superseded" };
          const record = options.store.read(options.userId);
          if (record.kind !== "found") return record;
          try {
            await options.flow.resume(record.orderId);
            if (disposed) return { kind: "disposed" };
            if (token !== generation) return { kind: "superseded" };
            const state = options.flow.snapshot();
            if (
              state.kind === "idle" ||
              state.kind === "creating" ||
              state.kind === "payment_required" ||
              !("orderId" in state) ||
              state.orderId !== record.orderId
            )
              return { kind: "superseded" };
            // Preserve even fulfilled/refund_pending records until the caller explicitly acknowledges them.
            return { kind: "restored", orderId: record.orderId, state };
          } catch {
            return disposed ? { kind: "disposed" } : { kind: "error" };
          }
        },
      );
      restoring = operation;
      void operation
        .finally(() => {
          if (restoring === operation) restoring = undefined;
        })
        .catch(() => {});
      return operation;
    },
    /** Forget only after an explicit UI decision (e.g. successful handoff or logout), not on unmount. */
    forget(orderId: string) {
      return options.store.forget(options.userId, orderId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      options.flow.reset();
      // Do not erase storage: navigation unmounts the page before it returns from the payment provider.
    },
  };
}
