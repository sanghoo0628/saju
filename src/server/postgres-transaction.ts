import type {
  Transaction,
  Order,
  ChatRequest,
  Conversation,
} from "../../packages/payment-chat/src/ports.ts";
import type { ChatMessage } from "../../contracts/payment-chat.ts";
import { ServiceError } from "../../packages/payment-chat/src/service.ts";
export interface SqlExecutor {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
}

type OrderRow = {
  id: string;
  buyer_id: string | null;
  target_id: string | null;
  match_result_id: string | null;
  amount: 500;
  reference: string;
  status: Order["status"];
};
type RequestRow = {
  id: string;
  requester_id: string;
  recipient_id: string;
  order_id: string;
  status: ChatRequest["status"];
  created_at: Date;
};
type RoomRow = { id: string; user_a: string; user_b: string; created_at: Date };
type MessageRow = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: Date;
};
const order = (r: OrderRow): Order => ({
  id: r.id,
  userId: r.buyer_id,
  targetId: r.target_id,
  matchResultId: r.match_result_id,
  amountKrw: r.amount,
  reference: r.reference,
  status: r.status,
});
const request = (r: RequestRow): ChatRequest => ({
  id: r.id,
  from: r.requester_id,
  to: r.recipient_id,
  orderId: r.order_id,
  status: r.status,
  createdAt: r.created_at.toISOString(),
});
const room = (r: RoomRow): Conversation => ({
  id: r.id,
  members: [r.user_a, r.user_b],
  createdAt: r.created_at.toISOString(),
});
const message = (r: MessageRow): ChatMessage => ({
  id: r.id,
  conversationId: r.conversation_id,
  senderId: r.sender_id,
  body: r.body,
  createdAt: r.created_at.toISOString(),
});

/** Server-only SQL mapping shared by the pg pool and migration tests. */
export function createPostgresTransaction(q: SqlExecutor): Transaction {
  async function one<T>(
    sql: string,
    params: unknown[],
  ): Promise<T | undefined> {
    return (await q.query(sql, params)).rows[0] as T | undefined;
  }
  async function orderQuery(sql: string, params: unknown[]) {
    const row = await one<OrderRow>(sql, params);
    return row ? order(row) : undefined;
  }
  async function requestQuery(sql: string, params: unknown[]) {
    const row = await one<RequestRow>(sql, params);
    return row ? request(row) : undefined;
  }
  async function roomQuery(sql: string, params: unknown[]) {
    const row = await one<RoomRow>(sql, params);
    return row ? room(row) : undefined;
  }
  // Validate scope here; compare the original DB timestamp in the page query to preserve microseconds.
  async function anchor(
    table: "chat_requests" | "conversations" | "messages",
    id: string,
    scope: string,
    params: unknown[],
  ) {
    const value = await one<{ id: string; created_at: Date }>(
      `select id,created_at from public.${table} where id=$1 and ${scope}`,
      [id, ...params],
    );
    if (!value)
      throw new ServiceError(
        "INVALID_REQUEST",
        "이 조회에 속하지 않는 커서입니다.",
      );
    return value;
  }
  return {
    order: (id) =>
      orderQuery(`select * from public.orders where id=$1 for update`, [id]),
    orderByReference: (reference) =>
      orderQuery(`select * from public.orders where reference=$1 for update`, [
        reference,
      ]),
    activeOrderForPair: (u, t) =>
      orderQuery(
        `select * from public.orders where buyer_id=$1 and target_id=$2 and status in ('pending','fulfilled') for update`,
        [u, t],
      ),
    async saveOrder(value) {
      await q.query(
        `insert into public.orders(id,buyer_id,target_id,match_result_id,amount,status,reference)
      values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set status=excluded.status`,
        [
          value.id,
          value.userId,
          value.targetId,
          value.matchResultId,
          value.amountKrw,
          value.status,
          value.reference,
        ],
      );
    },
    async paymentOrder(id) {
      return (
        await one<{ order_id: string }>(
          `select order_id from public.payments where transaction_id=$1`,
          [id],
        )
      )?.order_id;
    },
    async savePayment(transactionId, orderId) {
      await q.query(
        `insert into public.payments(transaction_id,order_id,amount) values($1,$2,500) `,
        [transactionId, orderId],
      );
    },
    async result(id) {
      const row = await one<{ id: string; user_id: string; target_id: string }>(
        `select id,user_id,target_id from public.match_results where id=$1`,
        [id],
      );
      return row
        ? { id: row.id, userId: row.user_id, targetId: row.target_id }
        : undefined;
    },
    async profileAvailable(id) {
      return (await one<{ ok: boolean }>(
        `select private.profile_available($1) ok`,
        [id],
      ))!.ok;
    },
    async blocked(a, b) {
      return (await one<{ ok: boolean }>(
        `select private.is_blocked_between($1,$2) ok`,
        [a, b],
      ))!.ok;
    },
    request: (id) =>
      requestQuery(
        `select * from public.chat_requests where id=$1 for update`,
        [id],
      ),
    requestForPair: (a, b) =>
      requestQuery(
        `select * from public.chat_requests where requester_id=$1 and recipient_id=$2 for update`,
        [a, b],
      ),
    async saveRequest(value) {
      await q.query(
        `insert into public.chat_requests(id,requester_id,recipient_id,order_id,status,created_at)
      values($1,$2,$3,$4,$5,$6) on conflict(id) do update set status=excluded.status,responded_at=now()`,
        [
          value.id,
          value.from,
          value.to,
          value.orderId,
          value.status,
          value.createdAt,
        ],
      );
    },
    async requestsForUser(userId, afterId) {
      const scope = `($2=requester_id or $2=recipient_id) and not private.is_blocked_between(requester_id,recipient_id)`;
      const cursor = afterId
        ? await anchor("chat_requests", afterId, scope, [userId])
        : undefined;
      const rows = await q.query(
        `select * from public.chat_requests where ($1=requester_id or $1=recipient_id)
        and not private.is_blocked_between(requester_id,recipient_id)
        ${cursor ? "and (created_at,id)<(select created_at,id from public.chat_requests where id=$2)" : ""} order by created_at desc,id desc limit 100`,
        cursor ? [userId, cursor.id] : [userId],
      );
      return (rows.rows as RequestRow[]).map(request);
    },
    conversation: (id) =>
      roomQuery(`select * from public.conversations where id=$1`, [id]),
    conversationForPair: (a, b) =>
      roomQuery(
        `select * from public.conversations where user_a=least($1::uuid,$2::uuid) and user_b=greatest($1::uuid,$2::uuid)`,
        [a, b],
      ),
    async saveConversation(value) {
      const [a, b] = [...value.members].sort();
      await q.query(
        `insert into public.conversations(id,user_a,user_b,created_at) values($1,$2,$3,$4) on conflict(id) do nothing`,
        [value.id, a, b, value.createdAt],
      );
    },
    async conversationsForUser(userId, afterId) {
      const scope = `($2=user_a or $2=user_b) and not private.is_blocked_between(user_a,user_b)`;
      const cursor = afterId
        ? await anchor("conversations", afterId, scope, [userId])
        : undefined;
      const rows = await q.query(
        `select * from public.conversations where ($1=user_a or $1=user_b)
        and not private.is_blocked_between(user_a,user_b)
        ${cursor ? "and (created_at,id)<(select created_at,id from public.conversations where id=$2)" : ""} order by created_at desc,id desc limit 100`,
        cursor ? [userId, cursor.id] : [userId],
      );
      return (rows.rows as RoomRow[]).map(room);
    },
    async message(id) {
      const row = await one<MessageRow>('select * from public.messages where id=$1', [id]);
      return row ? message(row) : undefined;
    },
    async saveMessage(value) {
      await q.query(
        `insert into public.messages(id,conversation_id,sender_id,body,created_at) values($1,$2,$3,$4,$5)`,
        [
          value.id,
          value.conversationId,
          value.senderId,
          value.body,
          value.createdAt,
        ],
      );
    },
    async messages(conversationId, afterId) {
      const cursor = afterId
        ? await anchor("messages", afterId, `conversation_id=$2`, [
            conversationId,
          ])
        : undefined;
      const rows = await q.query(
        `select * from public.messages where conversation_id=$1
        ${cursor ? "and (created_at,id)>(select created_at,id from public.messages where id=$2)" : ""} order by created_at,id limit 100`,
        cursor ? [conversationId, cursor.id] : [conversationId],
      );
      return (rows.rows as MessageRow[]).map(message);
    },
  };
}
