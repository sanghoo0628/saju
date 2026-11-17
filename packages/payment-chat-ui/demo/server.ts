import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, Connect } from "vite";
import { createService, ServiceError } from "../../payment-chat/src/service.ts";
import { createHttpApi } from "../../payment-chat/src/http.ts";
import type { CompletedPayment } from "../../payment-chat/src/ports.ts";
import { createDemoStore } from "./store.ts";
import { MY_ID } from "../src/catalog.ts";

const origin = "http://127.0.0.1:4173";
/** configureServer/PreviewServer에서만 활성화한다. 실제 배포용 결제 서버가 아니다. */
export function demoApi(): Plugin {
  const demoProof = randomUUID();
  let store = createDemoStore();
  const gateway = {
    productId: "demo-one-chat",
    checkoutUrl: (ref: string) =>
      `${origin}/?demoOrder=${encodeURIComponent(ref)}`,
    verifyCompleted: async (
      raw: Uint8Array,
      headers: Headers,
    ): Promise<CompletedPayment> => {
      if (headers.get("x-internal-demo-proof") !== demoProof)
        throw new ServiceError(
          "INVALID_WEBHOOK",
          "데모 검증을 통과하지 못했습니다.",
        );
      return JSON.parse(new TextDecoder().decode(raw));
    },
  };
  // 결제 URL의 외부 이동을 막기 위해 데모에서만 유효한 HTTPS 예시 주소를 반환한다.
  gateway.checkoutUrl = (ref: string) =>
    `https://demo.invalid/checkout?ref=${encodeURIComponent(ref)}`;
  let service = createService({ repository: store.repository, gateway });
  const handler = () =>
    createHttpApi({
      service,
      getCurrentUserId: async () => MY_ID,
      appOrigin: origin,
    });
  async function run(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/demo/")) return handler()(request);
    if (request.method !== "POST" || request.headers.get("origin") !== origin)
      return Response.json(
        { message: "허용되지 않은 데모 요청입니다." },
        { status: 403 },
      );
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16384)
      return Response.json({ message: "요청이 너무 큽니다." }, { status: 413 });
    const body = JSON.parse(text || "{}");
    if (path === "/api/demo/reset") {
      store = createDemoStore();
      service = createService({ repository: store.repository, gateway });
      return Response.json({ ok: true });
    }
    if (path === "/api/demo/complete-payment") {
      const order = store.state.orders.find(
        (x) => x.id === body.orderId && x.userId === MY_ID,
      );
      if (!order)
        throw new ServiceError("FORBIDDEN", "본인 주문만 체험할 수 있습니다.");
      if (
        !["success", "delay", "refund_pending", "cancelled"].includes(body.mode)
      )
        throw new ServiceError(
          "INVALID_REQUEST",
          "지원하지 않는 데모 시나리오입니다.",
        );
      if (body.mode === "cancelled") {
        await store.repository.transaction(async (tx) => {
          const current = await tx.order(order.id);
          if (!current || current.status !== "pending")
            throw new ServiceError(
              "INVALID_REQUEST",
              "미결제 주문만 취소 체험할 수 있습니다.",
            );
          await tx.saveOrder({ ...current, status: "cancelled" });
        });
        return Response.json({ status: "cancelled" });
      }
      if (body.mode === "refund_pending" && order.status === "pending") {
        // Demo only: an unavailable target makes the existing service retain payment for refund review.
        store.state.active = store.state.active.filter(
          (id) => id !== order.targetId,
        );
      }
      if (body.mode === "delay") return Response.json({ status: "pending" });
      const result = await service.paymentWebhook(
        new TextEncoder().encode(
          JSON.stringify({
            reference: order.reference,
            transactionId: `demo-payment-${order.id}`,
            productId: gateway.productId,
            amount: 500,
            currency: "KRW",
          }),
        ),
        new Headers({ "x-internal-demo-proof": demoProof }),
      );
      return Response.json(result);
    }
    if (path === "/api/demo/accept-request") {
      const invitation = store.state.requests.find(
        (x) => x.id === body.requestId && x.from === MY_ID,
      );
      if (!invitation)
        throw new ServiceError("FORBIDDEN", "보낸 요청만 체험할 수 있습니다.");
      return Response.json(
        await service.acceptChat({ userId: invitation.to }, invitation.id),
      );
    }
    if (path === "/api/demo/reply") {
      const room = store.state.rooms.find(
        (x) => x.id === body.conversationId && x.members.includes(MY_ID),
      );
      if (!room)
        throw new ServiceError("FORBIDDEN", "대화방을 찾을 수 없습니다.");
      const other = room.members.find((x) => x !== MY_ID)!;
      return Response.json(
        await service.sendMessage(
          { userId: other },
          room.id,
          "반가워요! 저도 관심사가 겹쳐서 이야기 나눠보고 싶었어요 :)",
        ),
      );
    }
    return Response.json(
      { message: "데모 경로를 찾을 수 없습니다." },
      { status: 404 },
    );
  }
  const middleware: Connect.NextHandleFunction = (
    req: IncomingMessage,
    res: ServerResponse,
    next,
  ) => {
    if (!req.url?.startsWith("/api/")) return next();
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value))
        value.forEach((item) => headers.append(key, item));
      else if (value) headers.set(key, value);
    }
    const request = new Request(new URL(req.url, origin), {
      method: req.method,
      headers,
      ...(!["GET", "HEAD"].includes(req.method ?? "GET")
        ? { body: Readable.toWeb(req), duplex: "half" }
        : {}),
    } as RequestInit);
    void run(request)
      .then(async (response) => {
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.setHeader("Cache-Control", "no-store");
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch((error) => {
        res.statusCode = error instanceof ServiceError ? 400 : 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            message:
              error instanceof ServiceError
                ? error.message
                : "데모 요청을 처리하지 못했습니다.",
          }),
        );
      });
  };
  return {
    name: "saju-local-demo-only",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
