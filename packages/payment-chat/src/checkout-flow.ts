import { PaymentChatClientError } from "./client.ts";
import type { createBrowserClient } from "./client.ts";

export type CheckoutState =
  | { kind: "idle" }
  | { kind: "creating"; matchResultId: string }
  | { kind: "payment_required"; orderId: string; checkoutUrl: string; amountKrw: 500 }
  | { kind: "checking"; orderId: string; attempt: number }
  | { kind: "confirmation_pending"; orderId: string }
  | { kind: "chat_available"; orderId?: string; conversationId?: string }
  | { kind: "refund_pending" | "refunded" | "cancelled"; orderId: string; refreshError?: string }
  | { kind: "error"; message: string; orderId?: string; matchResultId?: string };

type Client = Pick<ReturnType<typeof createBrowserClient>, "createOrder" | "order">;
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function retryable(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof PaymentChatClientError &&
    (error.status >= 500 || error.status === 408 || error.status === 429));
}
function messageFor(error: unknown) {
  return error instanceof PaymentChatClientError ? error.message : "연결을 확인하고 다시 시도해주세요.";
}

/**
 * 프레임워크에 독립적인 결제 화면 상태 처리. start()는 명시적인 구매 버튼에만 연결한다.
 * 결제창 이동은 payment_required 상태를 받은 화면이 수행한다. 자동 결제·자동 이동은 없다.
 * 복귀 화면은 resume(orderId)로 서버만 조회한다. URL의 성공 표시를 결제 증명으로 쓰지 않는다.
 */
export function createCheckoutFlow(options: {
  client: Client;
  maxAttempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  onObserverError?: (error: unknown) => void;
}) {
  const attempts = options.maxAttempts ?? 15;
  const interval = options.intervalMs ?? 2000;
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(interval) || interval < 0 ||
      !Number.isFinite(timeout) || timeout <= 0) throw new Error("결제 조회 설정이 올바르지 않습니다.");
  let state: CheckoutState = { kind: "idle" };
  let generation = 0;
  let current: AbortController | undefined;
  let disposed = false;
  let running: { key: string; promise: Promise<void> } | undefined;
  const observers = new Set<(value: CheckoutState) => void>();
  function emit(next: CheckoutState) {
    state = next;
    for (const observer of observers) {
      try { observer({ ...next }); }
      catch (error) { try { options.onObserverError?.(error); } catch { /* 상태 처리와 분리 */ } }
    }
  }
  function begin() {
    if (disposed) throw new Error("이미 해제한 결제 흐름입니다.");
    current?.abort();
    const token = ++generation;
    const controller = current = new AbortController();
    return { controller, active: () => !disposed && token === generation && !controller.signal.aborted,
      sameGeneration: () => !disposed && token === generation };
  }
  function run(key: string, work: (op: ReturnType<typeof begin>) => Promise<void>) {
    if (running?.key === key) return running.promise;
    const op = begin();
    // work를 microtask에서 실행하여 중복 클릭 전에 진행 중인 작업을 등록한다.
    const operation = Promise.resolve().then(() => work(op));
    running = { key, promise: operation };
    void operation.finally(() => { if (running?.promise === operation) running = undefined; }).catch(() => {});
    return operation;
  }
  return {
    snapshot: (): CheckoutState => ({ ...state }),
    subscribe(observer: (value: CheckoutState) => void) {
      if (disposed) throw new Error("이미 해제한 결제 흐름입니다.");
      observers.add(observer);
      return () => { observers.delete(observer); };
    },
    start(matchResultId: string): Promise<void> {
      return run(`start:${matchResultId}`, async op => {
        if (!op.active()) return;
        emit({ kind: "creating", matchResultId });
        try {
          const result = await options.client.createOrder(matchResultId, op.controller.signal);
          if (!op.active()) return;
          if (result.kind === "chat_available") { emit(result); return; }
          if (new URL(result.checkoutUrl).protocol !== "https:") throw new Error("안전하지 않은 결제 주소");
          emit({ ...result, kind: "payment_required" });
        } catch (error) {
          if (op.active()) emit({ kind: "error", message: messageFor(error), matchResultId });
        }
      });
    },
    resume(orderId: string): Promise<void> {
      const previousRefund = state.kind === "refund_pending" && state.orderId === orderId ? { ...state } : undefined;
      return run(`resume:${orderId}`, async op => {
        if (!op.active()) return;
        let receivedPending = false;
        const unconfirmed = (): CheckoutState => previousRefund && !receivedPending
          ? { ...previousRefund, refreshError: "최신 환불 상태를 확인하지 못했어요. 마지막으로 확인한 상태는 환불 대기예요. 연결을 확인한 뒤 다시 시도해주세요." }
          : { kind: "confirmation_pending", orderId };
        const timer = setTimeout(() => op.controller.abort(new DOMException("결제 확인 시간 초과", "TimeoutError")), timeout);
        try {
          for (let attempt = 1; attempt <= attempts; attempt++) {
            if (!op.active()) return;
            emit({ kind: "checking", orderId, attempt });
            try {
              const result = await options.client.order(orderId, op.controller.signal);
              if (!op.active()) return;
              if (result.orderId !== orderId) throw new PaymentChatClientError("INVALID_RESPONSE", "주문 응답을 확인할 수 없습니다.", 502);
              switch (result.status) {
                case "fulfilled": emit({ kind: "chat_available", orderId }); return;
                case "refund_pending": case "refunded": case "cancelled":
                  emit({ kind: result.status, orderId }); return;
                case "pending": receivedPending = true; break;
                default: throw new PaymentChatClientError("INVALID_RESPONSE", "주문 상태를 확인할 수 없습니다.", 502);
              }
            } catch (error) {
              if (!op.active()) return;
              if (!retryable(error)) { emit({ kind: "error", message: messageFor(error), orderId }); return; }
            }
            if (attempt < attempts) await (options.delay ?? wait)(interval, op.controller.signal);
          }
          if (op.active()) emit(unconfirmed());
        } catch (error) {
          if (op.active()) emit({ kind: "error", message: messageFor(error), orderId });
        } finally {
          clearTimeout(timer);
          if (op.sameGeneration() && op.controller.signal.aborted)
            emit(unconfirmed());
        }
      });
    },
    /** 화면 작업만 중단한다. 주문이나 Groble 결제를 취소하는 기능이 아니다. */
    reset() {
      generation++; current?.abort(); running = undefined;
      if (!disposed) emit({ kind: "idle" });
    },
    /** 로그아웃/계정 변경/화면 해제 시 호출하고 다음 사용자에게 상태를 재사용하지 않는다. */
    dispose() {
      disposed = true; generation++; current?.abort(); running = undefined;
      state = { kind: "idle" }; observers.clear();
    },
  };
}
