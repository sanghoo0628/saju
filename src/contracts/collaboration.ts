/**
 * A's compatibility import path. The source of truth is C's shared contract,
 * re-exported from C's shared contract.
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
  SendMessageRequest,
  SendMessageRequest as SendMessageInput,
  ApiErrorResponse,
  CreateOrderRequest as CreateConversationOrderInput,
  CreateOrderResponse as CreateConversationOrderResult,
  OrderResponse as ConversationOrderDto,
  CreateChatRequest as CreateChatRequestInput,
  ChatRequestResponse as ChatRequestDto,
  ChatMessage as MessageDto,
} from '../../contracts/payment-chat';

/** Message POST may include clientMessageId; reuse it only for the same send.
 * Sender and participation remain server-verified. The UI performs explicit retries only.
 */
