/**
 * C 담당 결제 및 채팅 API 계약 초안.
 * 프레임워크에 의존하지 않는 타입이며 실행 가능한 서버 구현은 아니다.
 * A의 인증 세션, B의 추천 및 권한 계약과 합의한 뒤 구현한다.
 */
export const MATCH_PRICE_KRW = 500 as const;
export const MATCH_PROFILE_COUNT = 3 as const;

export type OrderStatus =
  | "pending"
  | "fulfilled"
  | "cancelled"
  | "refund_pending"
  | "refunded";

/** POST /api/orders — 프로필 3명은 무료, 선택한 상대와 대화 시작은 상대당 500원.
 * 요청 본문에서 구매자, 금액, 점수, 결제 상태를 받지 않는다.
 * 서버가 인증 사용자와 추천 상대의 유효성을 확인하여 생성한다.
 */
export interface CreateOrderRequest {
  matchResultId: string;
}
export type CreateOrderResponse =
  | { kind: "payment_required"; orderId: string; amountKrw: typeof MATCH_PRICE_KRW; checkoutUrl: string }
  | { kind: "chat_available"; orderId?: string; conversationId?: string };

/** GET /api/orders/:id — 주문 소유자만 조회 가능.
 * 브라우저 복귀 URL은 결제 증명이 아니다.
 */
export interface OrderResponse {
  orderId: string;
  status: OrderStatus;
  /** NULL when the target account has been permanently deleted. */
  targetId: string | null;
}

/** B의 매칭 기능과 연결할 서버 내부 계약.
 * 검증된 결제만 입력하며, 거래 ID와 주문 ID로 중복 실행을 막는다.
 * 결제 기록과 선택한 상대에 대한 대화 권한을 트랜잭션으로 처리한다.
 */
export interface VerifiedPayment {
  orderId: string;
  providerTransactionId: string;
  amountKrw: typeof MATCH_PRICE_KRW;
}

/** POST /api/chat-requests
 * 서버는 선택한 상대에 대한 결제 권한, 차단 및 중복을 검증한다.
 */
export interface CreateChatRequest {
  orderId: string;
}

export interface ChatRequestResponse {
  id: string;
  from: string;
  to: string;
  orderId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
}

export interface ConversationResponse {
  id: string;
  members: [string, string];
  createdAt: string;
}

/** POST /api/chat-requests/:id/accept
 * 수신자만 수락할 수 있다. 두 사용자의 기존 대화방은 재사용한다.
 * 수신자는 별도 결제 없이 수락하고 대화한다.
 */
export interface AcceptChatRequestResponse {
  conversationId: string;
}

/** 서버 또는 Supabase가 생성한 메시지 조회 형태.
 * 전송 시 작성자는 인증 세션에서 결정하고 참여자 및 차단을 검사한다.
 * DB 저장 후 Realtime으로 전달하며 재접속 시 기록을 조회한다.
 */
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface ApiErrorResponse {
  code:
    | "UNAUTHENTICATED"
    | "FORBIDDEN"
    | "NOT_ENOUGH_CANDIDATES"
    | "ORDER_NOT_READY"
    | "INVALID_REQUEST"
    | "BLOCKED"
    | "PROVIDER_UNAVAILABLE"
    | "INVALID_WEBHOOK"
    | "NOT_FOUND"
    | "METHOD_NOT_ALLOWED"
    | "PAYLOAD_TOO_LARGE"
    | "UNSUPPORTED_MEDIA_TYPE"
    | "INTERNAL_ERROR";
  message: string;
}

/**
 * 구현 전 외부 확인:
 * - Groble: 500원 지원, 상품 ID, 테스트 방식, 웹훅 서명 원문 검증,
 *   재전송 정책, 거래 식별자, 취소/환불 이벤트, 협찬 수수료 범위.
 *   실제 이벤트 스키마는 공식 명세 확보 후 작성한다.
 * - A: 공통 프로젝트와 로그인 세션 확인 함수, 공통 배포 환경.
 * - B: 사용자 ID/프로필 구조, 무료 추천 3명 조회, 상대 활성/공개 상태,
 *   추천 결과 소유권과 대화방 참여자 RLS. 프로필 조회에는 결제를 요구하지 않는다.
 *
 * 구현 순서:
 * 1. 주문 생성/상태 조회 -> 2. 서명 검증 웹훅과 멱등 처리
 * 3. 상대별 대화 권한 연결 -> 4. 대화 요청/수락과 대화방
 * 5. 텍스트 메시지/RLS/Realtime/차단/신고 -> 6. 결제와 권한 통합 검증.
 * 관리자 키와 결제 비밀 키는 서버 환경 변수에만 보관한다.
 */
