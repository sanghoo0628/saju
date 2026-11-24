import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDb, seedUsers, recommend, uid, type TestDb } from '../db/harness';
import { createSqlProofRepository } from './c-sql-repository';
import { createService } from '../../packages/payment-chat/src/service';
import { createBrowserClient } from '../../packages/payment-chat/src/client';
import type { PaymentGateway } from '../../packages/payment-chat/src/ports';
import { createPaymentChatHandler } from '../../src/server/payment-chat-handler';
import { unavailablePaymentGateway } from '../../src/server/payment-gateway';
import { ApiError } from '../../src/lib/http/api';
import { ConfigurationError } from '../../src/lib/env/schema';

let db: TestDb;
let actor: string, calls: number, sequence: number;
let authFailure: Error | undefined;
let matchId: string;
let handler: ReturnType<typeof createPaymentChatHandler>;
const buyer = uid(1), recipient = uid(2), stranger = uid(3);
const origin = 'https://campus.example.test';
const gateway: PaymentGateway = { productId: 'test-only', checkoutUrl: reference => `https://checkout.example.test/?ref=${reference}`,
  verifyCompleted: async raw => JSON.parse(new TextDecoder().decode(raw)) };
function service(paymentGateway = unavailablePaymentGateway) {
  return createService({ repository: createSqlProofRepository(db), gateway: paymentGateway, id: () => uid(++sequence) });
}
function configure(paymentGateway?: PaymentGateway) {
  handler = createPaymentChatHandler({ service: service(paymentGateway), appOrigin: origin, requireUserId: async () => {
    calls++;
    if (authFailure) throw authFailure;
    return actor;
  } });
}
function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return handler(new Request(origin + path, body === undefined ? { headers } : {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
}
const browser = () => createBrowserClient((async (path, init) => handler(new Request(origin + String(path), {
  ...init, headers: { origin, ...Object.fromEntries(new Headers(init?.headers)) },
}))) as typeof fetch);
async function paidOrder() {
  const s = service(gateway);
  const created = await s.createOrder({ userId: buyer }, matchId);
  if (created.kind !== 'payment_required') throw new Error('fixture order missing');
  const reference = (await db.db.query<{ reference: string }>('select reference from public.orders where id=$1', [created.orderId])).rows[0]!.reference;
  await s.paymentWebhook(new TextEncoder().encode(JSON.stringify({ reference, transactionId: `test-${created.orderId}`, productId: gateway.productId, amount: 500, currency: 'KRW' })), new Headers());
  return created.orderId;
}
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.db.close(); });
beforeEach(async () => {
  // Isolated in-memory PostgreSQL only. Never uses DATABASE_URL or the shared development DB.
  await db.db.exec('truncate public.profiles,auth.users cascade');
  await seedUsers(db.db, [{ id: buyer, score: 3000 }, { id: recipient, score: -3001 }, { id: stranger, score: 9000 }]);
  matchId = (await recommend(db, buyer)).find(row => row.target_id === recipient)!.id;
  actor = buyer; calls = 0; sequence = 5000; authFailure = undefined; configure();
});

it('Next boundary maps missing login, school denial and configuration errors to C JSON', async () => {
  for (const [error, status, code] of [
    [new ApiError(401, 'UNAUTHORIZED', 'private'), 401, 'UNAUTHENTICATED'],
    [new ApiError(403, 'VERIFICATION_REQUIRED', 'private'), 403, 'FORBIDDEN'],
    [new ConfigurationError(['SUPABASE_SECRET_KEY']), 503, 'PROVIDER_UNAVAILABLE'],
    [new ApiError(503, 'SCHOOL_POLICY_NOT_CONFIGURED', 'private'), 503, 'PROVIDER_UNAVAILABLE'],
  ] as const) {
    authFailure = error;
    const response = await request('/api/conversations');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(response.headers.get('cache-control')).toContain('no-store');
  }
});

it('unconfigured Groble prevents new orders and rolls back all inserts', async () => {
  const response = await request('/api/orders', { matchResultId: matchId });
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe('PROVIDER_UNAVAILABLE');
  expect((await db.db.query('select id from public.orders')).rows).toHaveLength(0);
});

it('read requests are available independently of the unavailable checkout gateway', async () => {
  expect(await browser().conversations()).toEqual([]);
  expect(await browser().requests()).toEqual([]);
  expect(calls).toBe(2);
});

it('browser -> Next auth boundary -> B SQL -> existing paid right -> free accept -> messages', async () => {
  const orderId = await paidOrder();
  const api = browser();
  expect(await api.createOrder(matchId)).toMatchObject({ kind: 'chat_available', orderId });
  const invitation = await api.requestChat(orderId);
  actor = recipient;
  expect(await api.requests()).toEqual([invitation]);
  const { conversationId } = await api.acceptChat(invitation.id);
  const message = await api.sendMessage(conversationId, '실제 C 화면에서 사용하는 요청');
  expect(message.senderId).toBe(recipient);
  actor = buyer;
  expect(await api.messages(conversationId)).toEqual([message]);
  expect(await api.createOrder(matchId)).toMatchObject({ kind: 'chat_available', conversationId });
  actor = stranger;
  await expect(api.messages(conversationId)).rejects.toMatchObject({ status: 403 });
  expect(calls).toBeGreaterThanOrEqual(8);
});

it('Next boundary preserves origin and actor-spoof rejection', async () => {
  expect((await request('/api/orders', { matchResultId: matchId }, { origin: 'https://attacker.invalid' })).status).toBe(403);
  expect(calls).toBe(0);
  expect((await request('/api/orders', { matchResultId: matchId, buyer_id: recipient })).status).toBe(400);
});

it('unconfigured webhook needs no user session and cannot grant payment rights', async () => {
  authFailure = new ApiError(401, 'UNAUTHORIZED', 'private');
  const response = await request('/api/webhooks/groble', { status: 'paid' });
  expect(response.status).toBe(503);
  expect(calls).toBe(0);
  expect((await db.db.query('select * from public.payments')).rows).toEqual([]);
});

it('Next boundary forwards raw webhook bytes and signature headers unchanged', async () => {
  const raw = ' { "payment": "완료" }\n';
  configure({ ...gateway, verifyCompleted: async (bytes, headers) => {
    expect(new TextDecoder().decode(bytes)).toBe(raw);
    expect(headers.get('x-test-signature')).toBe('unit-test-only');
    throw new ConfigurationError(['TEST_ONLY']);
  } });
  const response = await handler(new Request(origin + '/api/webhooks/groble', { method: 'POST', body: raw, headers: { 'x-test-signature': 'unit-test-only' } }));
  expect(response.status).toBe(500);
  expect(calls).toBe(0);
});

it('unexpected Next boundary failures invoke the diagnostic hook without exposing the error', async () => {
  const {logPaymentChatError}=await import('../../src/server/payment-chat-diagnostics');
  const entries:unknown[]=[];
  handler=createPaymentChatHandler({service:service(),appOrigin:origin,requireUserId:async()=>{
    throw Object.assign(new Error('private authentication detail'),{code:'ECONNRESET'});
  },onUnexpectedError:error=>logPaymentChatError('request',error,entry=>entries.push(entry))});
  const response=await request('/api/conversations');
  expect(response.status).toBe(500);
  expect(entries).toEqual([{event:'payment_chat_unexpected_error',phase:'request',name:'Error',code:'ECONNRESET'}]);
  expect(await response.text()).not.toContain('private authentication detail');
});

it('configuration errors preserve 503 while emitting only sanitized diagnostics', async () => {
  const {logPaymentChatError}=await import('../../src/server/payment-chat-diagnostics');
  const entries:unknown[]=[];
  handler=createPaymentChatHandler({service:service(),appOrigin:origin,requireUserId:async()=>{
    throw new ConfigurationError(['PRIVATE_CONFIG_FIELD']);
  },onUnexpectedError:error=>logPaymentChatError('request',error,entry=>entries.push(entry))});
  const response=await request('/api/conversations');
  expect(response.status).toBe(503);
  expect(entries).toEqual([{event:'payment_chat_unexpected_error',phase:'request',name:'ConfigurationError',code:'CONFIGURATION_ERROR'}]);
  expect(await response.text()).not.toContain('PRIVATE_CONFIG_FIELD');
});
