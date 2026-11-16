import type { ChatMessage, OrderStatus } from "../../../contracts/payment-chat.ts";

/** HTTP 입력이 아닌 서버에서 검증한 로그인 세션에서 생성한다. */
export interface Actor { userId: string }
export interface Order {
  id: string;
  userId: string;
  reference: string;
  targetId: string;
  matchResultId: string;
  amountKrw: 500;
  status: OrderStatus;
}
export interface MatchResult { id: string; userId: string; targetId: string }
export interface ChatRequest {
  id: string;
  from: string;
  to: string;
  orderId: string;
  status: "pending" | "accepted" | "rejected";
}
export interface Conversation { id: string; members: [string, string] }

/** 검증기가 원문 서명과 제공자 이벤트를 확인한 뒤 반환하는 내부 형식. */
export interface CompletedPayment {
  reference: string;
  transactionId: string;
  productId: string;
  amount: number;
  currency: string;
}
export interface PaymentGateway {
  productId: string;
  checkoutUrl(reference: string): string;
  /** 유효한 완료 이벤트만 반환한다. 잘못된 서명/이벤트는 예외로 거부한다. */
  verifyCompleted(rawBody: Uint8Array, headers: Headers): Promise<CompletedPayment>;
}

/**
 * 모든 메서드는 같은 DB 트랜잭션 안에서 실행되어야 한다.
 * 추천 결과 소유권 및 상대의 활성·공개 상태를 검증한다.
 * 운영 어댑터는 사용자별 생성 작업을 직렬화하고 결제 식별자/참조값,
 * 사용자-상대별 활성 주문, 요청자-수신자 및 두 참여자 채팅방의 고유 제약을 적용한다.
 */
export interface Transaction {
  order(id: string): Promise<Order | undefined>;
  orderByReference(reference: string): Promise<Order | undefined>;
  activeOrderForPair(userId: string, targetId: string): Promise<Order | undefined>;
  saveOrder(order: Order): Promise<void>;
  paymentOrder(transactionId: string): Promise<string | undefined>;
  savePayment(transactionId: string, orderId: string): Promise<void>;
  result(id: string): Promise<MatchResult | undefined>;
  profileAvailable(userId: string): Promise<boolean>;
  blocked(a: string, b: string): Promise<boolean>;
  request(id: string): Promise<ChatRequest | undefined>;
  requestForPair(from: string, to: string): Promise<ChatRequest | undefined>;
  saveRequest(request: ChatRequest): Promise<void>;
  conversation(id: string): Promise<Conversation | undefined>;
  conversationForPair(a: string, b: string): Promise<Conversation | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;
  saveMessage(message: ChatMessage): Promise<void>;
  /** afterId가 해당 대화에 속하는지 검증하고 시각과 ID로 정렬하여 최대 100개를 반환한다. */
  messages(conversationId: string, afterId?: string): Promise<ChatMessage[]>;
}
export interface Repository {
  /** 원자적 commit/rollback과 동시 요청의 serializable 처리를 보장한다. */
  transaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T>;
}
