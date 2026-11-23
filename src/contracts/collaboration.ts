/**
 * A's compatibility import path. The source of truth is C's shared contract,
 * mirrored unchanged from sanghoo0628/saju@c098404 (also unchanged at b4cdf40).
 * This imports types only; it does not activate C's runtime or payment routes.
 * See docs/A_BC_INTEGRATION_DESIGN.md for the integration boundary.
 */
export { MATCH_PRICE_KRW, MATCH_PROFILE_COUNT } from '../../contracts/payment-chat';
export type {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderResponse,
  OrderStatus,
  VerifiedPayment,
  CreateChatRequest,
  ChatRequestResponse,
  ConversationResponse,
  AcceptChatRequestResponse,
  ChatMessage,
  ApiErrorResponse,
  CreateOrderRequest as CreateConversationOrderInput,
  CreateOrderResponse as CreateConversationOrderResult,
  OrderResponse as ConversationOrderDto,
  CreateChatRequest as CreateChatRequestInput,
  ChatRequestResponse as ChatRequestDto,
  ChatMessage as MessageDto,
} from '../../contracts/payment-chat';

/** POST /api/conversations/:id/messages. C derives sender from verified auth.
 * Conversation ID belongs in the URL. C currently has no server idempotency key
 * for message POST; do not automatically retry an ambiguous send.
 */
export interface SendMessageInput {
  body: string;
}
