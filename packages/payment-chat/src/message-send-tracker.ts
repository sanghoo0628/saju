import { isClientMessageId, type ChatMessage } from '../../../contracts/payment-chat.ts';

export interface MessageSendAttempt { clientMessageId: string; body: string }
export class PendingMessageError extends Error {
  constructor() { super('먼저 이전 메시지의 전송 상태를 확인해주세요.'); }
}

/** One unresolved send per mounted user/room. No automatic POST retry or persisted message body. */
export function createMessageSendTracker(userId: string, conversationId: string, id: () => string = () => crypto.randomUUID()) {
  let pending: MessageSendAttempt | undefined;
  let disposed = false;
  const matches = (attempt: MessageSendAttempt, message: ChatMessage) =>
    !disposed && message.id === attempt.clientMessageId && message.senderId === userId &&
    message.conversationId === conversationId && message.body === attempt.body;
  return {
    prepare(body: string): MessageSendAttempt {
      if (disposed) throw new Error('Message send tracker is disposed');
      if (typeof body !== 'string' || !body.trim() || body.length > 2000) throw new Error('Invalid message body');
      if (pending && pending.body !== body.trim()) throw new PendingMessageError();
      if (!pending) {
        const clientMessageId = id();
        if (!isClientMessageId(clientMessageId)) throw new Error('A canonical random message UUID is required');
        pending = { clientMessageId, body: body.trim() };
      }
      return { ...pending };
    },
    pending: () => pending ? { ...pending } : undefined,
    matches,
    /** A matching POST response, history row or Realtime insert can confirm delivery. */
    confirm(message: ChatMessage): MessageSendAttempt | undefined {
      if (!pending || !matches(pending, message)) return;
      const confirmed = { ...pending }; pending = undefined; return confirmed;
    },
    dispose() { disposed = true; pending = undefined; },
  };
}
