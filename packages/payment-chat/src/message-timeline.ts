import type { ChatMessage } from "../../../contracts/payment-chat.ts";

export interface MessageTimelineSnapshot {
  messages: ChatMessage[];
  historyCursor?: string;
  historyComplete: boolean;
}
export interface HistoryPageCursor { afterId?: string; revision: number }

/**
 * 채팅 기록과 전송 응답/Realtime의 같은 메시지를 ID로 합친다.
 * Realtime에서 받은 최신 ID는 DB 기록 조회 커서로 사용하지 않는다.
 * 인스턴스는 로그인 사용자와 채팅방별로 생성한다. 방 변경 시 새 인스턴스를 사용한다.
 */
export function createMessageTimeline(conversationId: string) {
  let byId = new Map<string, ChatMessage>();
  let cursor: string | undefined;
  let complete = false;
  let revision = 0;
  function valid(message: unknown): message is ChatMessage {
    if (!message || typeof message !== "object") return false;
    const value = message as Partial<ChatMessage>;
    return value.conversationId === conversationId && typeof value.id === "string" && !!value.id &&
      typeof value.body === "string" && typeof value.senderId === "string" && !!value.senderId &&
      typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
  }
  function copy(message: ChatMessage): ChatMessage {
    return { id:message.id, conversationId:message.conversationId, senderId:message.senderId,
      body:message.body, createdAt:message.createdAt };
  }
  function snapshot(): MessageTimelineSnapshot {
    return {
      messages: [...byId.values()].map(message => ({ ...message })).sort((a,b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      historyCursor: cursor, historyComplete: complete,
    };
  }
  return {
    snapshot,
    /** 메시지 전송 응답도 이 메서드로 합친다. 다른 방/잘못된 이벤트는 무시한다. */
    receive(message: unknown) {
      if (!valid(message)) return false;
      byId.set(message.id, copy(message));
      return true;
    },
    nextHistoryPage: (): HistoryPageCursor => ({ afterId:cursor, revision }),
    /** client.messages(roomId, token.afterId)의 응답과 요청 당시 token을 함께 전달한다. */
    appendHistory(messages: ChatMessage[], token: HistoryPageCursor) {
      if (token.revision !== revision || token.afterId !== cursor) return false;
      if (messages.length > 100 || messages.some(message => !valid(message)))
        throw new Error("채팅 기록 응답이 올바르지 않습니다.");
      if (messages.length && messages.at(-1)!.id === cursor)
        throw new Error("채팅 조회 커서가 진행하지 않습니다.");
      for (const message of messages) byId.set(message.id, copy(message));
      if (messages.length) cursor = messages.at(-1)!.id;
      complete = messages.length < 100;
      revision++;
      return true;
    },
    /** 연결 복구 시 처음부터 재조회하여 연결이 끊긴 사이의 누락을 채운다. 표시 기록은 유지한다. */
    restartHistory() { cursor = undefined; complete = false; revision++; },
    /** 로그아웃 또는 권한/차단 오류 시 화면에서도 보관 기록을 제거한다. */
    clear() { byId = new Map(); cursor = undefined; complete = false; revision++; },
  };
}
