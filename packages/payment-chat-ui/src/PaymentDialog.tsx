"use client";

import { useState } from "react";
import type { CheckoutState } from "../../payment-chat/src/checkout-flow.ts";
import type { ChatProfile } from "./types.ts";
import { Avatar, Busy, Icon, Modal } from "./ui.tsx";

export type DemoPaymentMode =
  | "success"
  | "delay"
  | "refund_pending"
  | "cancelled";
export type PaymentAction =
  | { kind: "checkout"; onCheckout: () => void }
  | {
      kind: "demo";
      onConfirm: (mode: DemoPaymentMode) => void;
      onFinishDelayedPayment: () => void;
    };

export function PaymentDialog({
  profile,
  state,
  busy,
  onClose,
  paymentAction,
  onRequest,
  onRecheck,
  onRetry,
  actionError,
}: {
  profile: ChatProfile;
  state: CheckoutState;
  busy: boolean;
  onClose: () => void;
  paymentAction: PaymentAction;
  onRequest: () => void;
  onRecheck: () => void;
  onRetry: () => void;
  actionError: string;
}) {
  const [mode, setMode] = useState<
    "success" | "delay" | "refund_pending" | "cancelled"
  >("success");
  const demo = paymentAction.kind === "demo" ? paymentAction : undefined;
  const existingRoom =
    state.kind === "chat_available" && !!state.conversationId;
  const ready = state.kind === "chat_available";
  const waiting =
    state.kind === "checking" ||
    state.kind === "creating" ||
    state.kind === "idle";
  const pending = state.kind === "confirmation_pending";
  const terminal = ["refund_pending", "refunded", "cancelled"].includes(
    state.kind,
  );
  return (
    <Modal title="대화 시작하기" onClose={onClose} className="payment-modal">
      <div className="eyebrow">A LITTLE HELLO</div>
      <h2>
        {terminal
          ? "주문 상태를 확인해주세요"
          : ready
            ? existingRoom
              ? "대화를 이어가볼까요?"
              : "이제, 인사를 건네볼까요?"
            : pending
              ? "결제를 확인하고 있어요"
              : "인연의 다음 장을 열어볼까요?"}
      </h2>
      <p className="modal-subtitle">
        {terminal
          ? "이 주문으로는 대화를 요청할 수 없어요."
          : ready
            ? existingRoom
              ? "추가 결제 없이 기존 대화로 이동해요."
              : "대화 요청을 보내면 상대방에게 전달돼요."
            : pending
              ? "확인이 늦어져도 다시 결제하지 않아도 돼요."
              : "마음이 닿은 한 사람에게, 가벼운 첫인사를."}
      </p>
      <div className="payment-person">
        <Avatar name={profile.nickname} tone={profile.tone} small />
        <div>
          <strong>{profile.nickname}</strong>
          <span>{profile.major ?? "공개된 학과 정보가 없어요"}</span>
        </div>
        <span className="match-pill">나의 추천 인연</span>
      </div>
      <div className="receipt">
        <div>
          <span>이 상대에게 대화 요청</span>
          <strong>
            500<span>원</span>
          </strong>
        </div>
        <div className="receipt-note">
          <Icon name="check" size={15} />
          같은 상대와의 대화는 추가 결제 없이 이어져요
        </div>
      </div>
      {ready ? (
        <div className="success-note" role="status">
          <Icon name="check" size={18} />이 상대와 대화할 수 있는 권한이
          확인됐어요.
        </div>
      ) : null}
      <ul className="payment-notes">
        <li>프로필 확인은 무료예요.</li>
        <li>상대가 수락하면 일대일 대화가 시작돼요.</li>
        <li>상대의 수락이나 답장을 보장하지는 않아요.</li>
      </ul>
      {actionError ? (
        <p className="inline-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {"orderId" in state && state.orderId ? (
        <p className="order-reference">
          주문 번호 <span>{state.orderId}</span>
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="inline-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {["refund_pending", "refunded", "cancelled"].includes(state.kind) ? (
        <p className="inline-error" role="status">
          {state.kind === "refund_pending"
            ? "환불 확인을 기다리고 있어요. 아직 환불이 완료된 상태는 아니에요."
            : state.kind === "refunded"
              ? "환불된 주문이에요."
              : "취소된 주문이에요."}
        </p>
      ) : null}
      {waiting || busy ? (
        <button className="primary wide" disabled>
          <Busy text={state.kind === "checking" ? "결제 확인 중" : "처리 중"} />
        </button>
      ) : ready ? (
        <button className="primary wide" onClick={onRequest}>
          {existingRoom ? "대화 이어가기" : "대화 요청 보내기"}
          <Icon name="arrow" size={18} />
        </button>
      ) : pending ? (
        <button className="primary wide" onClick={onRecheck}>
          같은 주문 다시 확인
          <Icon name="refresh" size={18} />
        </button>
      ) : state.kind === "error" && (state.orderId || state.matchResultId) ? (
        <button className="primary wide" onClick={onRetry}>
          {state.orderId ? "같은 주문 다시 확인" : "주문 준비 다시 시도"}
          <Icon name="refresh" size={18} />
        </button>
      ) : state.kind === "refund_pending" ? (
        <button className="secondary wide" onClick={onRecheck}>
          환불 상태 다시 확인
        </button>
      ) : state.kind === "payment_required" ? (
        <button
          className="primary wide"
          onClick={() => {
            if (paymentAction.kind === "demo") paymentAction.onConfirm(mode);
            else paymentAction.onCheckout();
          }}
        >
          <Icon name="lock" size={17} />
          {demo ? "500원 결제 체험하기" : "500원 결제하기"}
        </button>
      ) : (
        <button className="secondary wide" onClick={onClose}>
          닫기
        </button>
      )}
      {pending && demo ? (
        <button
          className="secondary wide delayed-demo"
          disabled={busy}
          onClick={demo.onFinishDelayedPayment}
        >
          지연된 데모 결제 완료하기
        </button>
      ) : null}
      {demo ? (
        <p className="demo-fineprint">
          데모 화면이에요. 실제 결제나 청구가 발생하지 않아요.
        </p>
      ) : null}
      {state.kind === "payment_required" && demo ? (
        <details className="scenario">
          <summary>데모 시나리오 선택</summary>
          <div className="segmented">
            {(
              [
                ["success", "바로 확인"],
                ["delay", "확인 지연"],
                ["refund_pending", "환불 대기"],
                ["cancelled", "결제 취소"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={mode === value ? "selected" : ""}
                aria-pressed={mode === value}
                disabled={busy}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </details>
      ) : null}
    </Modal>
  );
}
