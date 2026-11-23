import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { PaymentDialog, type PaymentAction } from "../src/PaymentDialog.tsx";
import { ChatPanel } from "../src/ChatPanel.tsx";
import type { ChatProfile } from "../src/types.ts";
import { createBrowserClient } from "../../payment-chat/src/client.ts";
import type { CheckoutState } from "../../payment-chat/src/checkout-flow.ts";
import type {
  ChatRequestResponse,
  ConversationResponse,
} from "../../../contracts/payment-chat.ts";
import type { ProfileCard } from "../../../src/contracts/matching.ts";

const ME = "40000000-0000-4000-8000-000000000001";
const PEER = "40000000-0000-4000-8000-000000000002";
const OTHER = "40000000-0000-4000-8000-000000000003";
// A real B response: no score, class year or demo name/tone is present.
const profile: ProfileCard = {
  userId: PEER,
  nickname: "실제 공개 별명",
  major: null,
  gender: null,
  university: "고려대학교",
  bio: "공개 소개",
  interests: [],
  track: "science",
  photoUrl: null,
};
const profiles: ChatProfile[] = [profile];
const request: ChatRequestResponse = {
  id: "request",
  from: PEER,
  to: ME,
  orderId: "order",
  status: "pending",
  createdAt: "2026-11-17T00:00:00Z",
};
const room: ConversationResponse = {
  id: "room",
  members: [ME, PEER],
  createdAt: request.createdAt,
};
const noop = () => {};
const api = createBrowserClient(vi.fn());
function payment(
  state: CheckoutState,
  action: PaymentAction = { kind: "checkout", onCheckout: noop },
) {
  return renderToStaticMarkup(
    createElement(PaymentDialog, {
      profile,
      state,
      busy: false,
      actionError: "",
      onClose: noop,
      onRequest: noop,
      onRecheck: noop,
      onRetry: noop,
      paymentAction: action,
    }),
  );
}
function panel(options: Partial<Parameters<typeof ChatPanel>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      currentUserId: ME,
      profiles,
      rooms: [room],
      requests: [request],
      selection: { kind: "request", id: request.id },
      listLoading: false,
      listError: "",
      onReload: noop,
      onSelect: noop,
      onAccept: async () => {},
      onReject: async () => {},
      api,
      busy: false,
      ...options,
    }),
  );
}

describe("reusable payment UI", () => {
  it("accepts B's public profile without score/year and renders real checkout only", () => {
    const html = payment({
      kind: "payment_required",
      orderId: "order",
      amountKrw: 500,
      checkoutUrl: "https://checkout.example",
    });
    expect(html).toContain("실제 공개 별명");
    expect(html).toContain("500원 결제하기");
    expect(html).toContain("공개된 학과 정보가 없어요");
    expect(html).not.toMatch(/체험|데모|시나리오|학번|인연수/);
  });
  it("requires explicit demo actions to display simulated payment controls", () => {
    const html = payment(
      {
        kind: "payment_required",
        orderId: "order",
        amountKrw: 500,
        checkoutUrl: "https://checkout.example",
      },
      { kind: "demo", onConfirm: noop, onFinishDelayedPayment: noop },
    );
    expect(html).toContain("500원 결제 체험하기");
    expect(html).toContain("데모 시나리오 선택");
  });
  it("offers read-only recheck without a simulated completion button in live mode", () => {
    const html = payment({
      kind: "confirmation_pending",
      orderId: "same-order",
    });
    expect(html).toContain("same-order");
    expect(html).toContain("같은 주문 다시 확인");
    expect(html).not.toContain("지연된 데모 결제 완료하기");
    expect(html).not.toContain("500원 결제하기");
  });
  it("routes an existing room to continuation rather than a new invitation", () => {
    const html = payment({
      kind: "chat_available",
      conversationId: "existing-room",
    });
    expect(html).toContain("대화 이어가기");
    expect(html).not.toContain("대화 요청 보내기");
    expect(html).not.toContain("500원 결제하기");
  });
  it.each(["refund_pending", "refunded", "cancelled"] as const)(
    "never offers payment or a request for %s",
    (kind) => {
      const html = payment({ kind, orderId: "order" });
      expect(html).not.toContain("500원 결제하기");
      expect(html).not.toContain("대화 요청 보내기");
    },
  );
});

describe("chat identity and demo isolation", () => {
  it("determines incoming requests using an injected Supabase UUID", () => {
    const html = panel();
    expect(html).toContain("실제 공개 별명님이 인사를 건넸어요");
    expect(html).toContain("수락하고 대화하기");
    expect(html).not.toMatch(/상대 수락 체험|상대 답장 체험|서연|민준|demo-me/);
  });
  it("changes incoming/outgoing direction for the opposite signed-in user", () => {
    const html = panel({
      currentUserId: PEER,
      profiles: [{ userId: ME, nickname: "첫 사용자", major: "철학과" }],
    });
    expect(html).toContain("첫 사용자님의 수락을 기다려요");
    expect(html).not.toContain("수락하고 대화하기");
    expect(html).not.toContain("상대 수락 체험");
  });
  it("filters stale foreign rooms and requests after an account change", () => {
    const html = panel({ currentUserId: OTHER });
    expect(html).not.toContain("실제 공개 별명");
    expect(html).not.toContain("수락하고 대화하기");
    expect(html).not.toContain("요청을 잘 전달했어요");
    expect(html).not.toContain("has-selection");
  });
  it("resolves the peer even when the current user's profile is first", () => {
    const html = panel({
      selection: { kind: "room", id: room.id },
      profiles: [{ userId: ME, nickname: "나 자신", major: null }, profile],
    });
    expect(html).toContain("실제 공개 별명");
    expect(html).not.toContain("나 자신");
    expect(html).not.toContain("상대 답장 체험");
  });
  it("keeps a mobile back button and a neutral name when a profile is unavailable", () => {
    const html = panel({ profiles: [] });
    expect(html).toContain("대화 목록으로");
    expect(html).toContain("상대방님이 인사를 건넸어요");
    expect(html).not.toContain("undefined");
  });
  it("shows simulated accept only when the caller explicitly provides it", () => {
    const html = panel({
      currentUserId: PEER,
      demo: { onAcceptRequest: async () => {} },
    });
    expect(html).toContain("상대 수락 체험");
  });
});

it("shows connection status when a realtime source is supplied without adding demo controls", () => {
  const html = panel({
    selection: { kind: "room", id: room.id },
    messageSource: {
      subscribe() {
        return () => {};
      },
    },
  });
  expect(html).toContain("실시간 연결 중");
  expect(html).not.toContain("상대 답장 체험");
});

it("shows the recipient's rejection result without a waiting message or simulated retry", () => {
  const html = panel({
    currentUserId: PEER,
    requests: [{ ...request, status: "rejected" }],
    demo: { onAcceptRequest: async () => {} },
  });
  expect(html).toContain("이번 요청은 수락되지 않았어요");
  expect(html).toContain("상대가 거절한 요청이에요");
  expect(html).not.toContain("수락을 기다려요");
  expect(html).not.toContain("상대 수락 체험");
});
it("shows accepted requests awaiting their room with a read-only refresh action", () => {
  const html = panel({
    rooms: [],
    requests: [{ ...request, status: "accepted" }],
  });
  expect(html).toContain("대화 요청이 수락됐어요");
  expect(html).toContain("대화방 다시 확인");
  expect(html).not.toContain("수락을 기다려요");
  expect(html).not.toContain("수락하고 대화하기");
});
it("distinguishes a request I rejected from one the peer rejected", () => {
  const html = panel({ requests: [{ ...request, status: "rejected" }] });
  expect(html).toContain("대화 요청을 거절했어요");
  expect(html).toContain("내가 거절한 요청이에요");
  expect(html).not.toContain("수락하고 대화하기");
});
it("makes a capped list visible to the user instead of implying all history was loaded", () => {
  const html = panel({ listHasMore: true });
  expect(html).toContain("목록이 많아 최근 내역부터 표시했어요");
});

describe("completed request history", () => {
  it("keeps a declined outgoing request discoverable after leaving its detail", () => {
    const html = panel({ currentUserId: PEER, selection: null, requests: [{ ...request, status: "rejected" }] });
    expect(html).toContain("이전 대화 요청");
    expect(html).toContain("보낸 요청");
    expect(html).toContain("거절됨");
    expect(html).not.toContain("수락을 기다리고 있어요");
    expect(html).not.toContain("500원");
  });
  it("shows incoming rejection history without an accept or payment action", () => {
    const html = panel({ selection: null, requests: [{ ...request, status: "rejected" }] });
    expect(html).toContain("받은 요청");
    expect(html).toContain("거절함");
    expect(html).not.toContain("수락하고 대화하기");
    expect(html).not.toContain("500원");
  });
  it("offers free continuation for accepted history with an existing room", () => {
    const html = panel({ selection: null, requests: [{ ...request, status: "accepted" }] });
    expect(html).toContain("수락됨");
    expect(html).toContain("대화 이어가기 · 무료");
    expect(html).not.toContain("500원");
  });
  it("does not promise a room when an accepted request has not resolved to one", () => {
    const html = panel({ rooms: [], selection: null, requests: [{ ...request, status: "accepted" }] });
    expect(html).toContain("수락됨");
    expect(html).not.toContain("대화 이어가기 · 무료");
  });
  it("does not expose another account's completed requests", () => {
    const html = panel({ currentUserId: OTHER, requests: [{ ...request, status: "rejected" }] });
    expect(html).not.toContain("이전 대화 요청");
    expect(html).not.toContain("실제 공개 별명");
  });
  it("does not duplicate a pending request in completed history", () => {
    const html = panel({ selection: null });
    expect(html).toContain("새로운 대화 요청이 왔어요");
    expect(html).not.toContain("이전 대화 요청");
  });
});
