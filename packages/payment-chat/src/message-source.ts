import type { ChatMessage } from "../../../contracts/payment-chat.ts";
export type MessageSourceStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "auth_required"
  | "closed";
export interface MessageSource {
  subscribe(options: {
    userId: string;
    conversationId: string;
    onMessage: (message: ChatMessage) => void;
    onStatus: (status: MessageSourceStatus) => void;
  }): () => void;
}
/** Return a cancellation function; injectable for deterministic retry/poll tests. */
export type Schedule = (run: () => void, delayMs: number) => () => void;
export const schedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};
