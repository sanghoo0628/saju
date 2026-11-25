import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { createGrobleWebhookHandler } from '../../src/server/groble-webhook-handler';
import { createGrobleInbox } from '../../src/server/groble-inbox';
import type { GroblePaymentEvent } from '../../src/server/groble-events';
import { createPostgresRepository } from '../../src/server/postgres-repository';
import { createService } from '../../packages/payment-chat/src/service';
import { startNativePostgres } from './native-postgres';
import { seedUsers, uid } from '../db/harness';
const buyer = uid(1), target = uid(2), merchant = 'merchant-fixture';
let db: Awaited<ReturnType<typeof startNativePostgres>>;
let inbox: ReturnType<typeof createGrobleInbox>;
let service: ReturnType<typeof createService>;
let orderId: string, reference: string;
const parse = async (raw: Uint8Array): Promise<GroblePaymentEvent> => JSON.parse(Buffer.from(raw).toString());
const options = { retryDelayMs: 0, maxRetries: 10 };
const event = (id: string, type: 'payment.completed' | 'payment.cancel_requested' | 'payment.refunded' = 'payment.completed'): GroblePaymentEvent => {
  const base = { eventId:id,idempotencyKey:`key-${id}`,occurredAt:'2026-11-25T12:00:00Z',transactionId:merchant,productId:'product',amount:500 as const,currency:'KRW' as const };
  if (type === 'payment.completed') return {...base,type,reference};
  if (type === 'payment.cancel_requested') return {...base,type,requestedAt:'2026-11-25T12:00:00Z'};
  return {...base,type,refundAmount:500,partialRefund:false,refundedAt:'2026-11-25T12:01:00.000Z',refundDeduplicationKey:JSON.stringify([merchant,'2026-11-25T12:01:00.000Z'])};
};
const deliver = (value: GroblePaymentEvent, instance = inbox) => instance.receive(Buffer.from(JSON.stringify(value)), new Headers());
const scalar = async (sql: string) => (await db.pool.query(sql)).rows[0].value;
const status = () => scalar(`select status as value from public.orders where id='${orderId}'`);
beforeAll(async () => { db = await startNativePostgres(); }, 60000);
afterAll(async () => { if (db) await db.close(); }, 30000);
beforeEach(async () => {
  await db.pool.query(`truncate private.groble_deliveries,private.groble_events,private.groble_refunds,
    public.messages,public.conversations,public.chat_requests,public.payments,public.orders,public.match_results,auth.users cascade`);
  await seedUsers(db.pool,[{id:buyer,score:1000},{id:target,score:-1000}]);
  const results = (await db.pool.query('select id from public.get_or_create_match_results($1)',[buyer])).rows;
  service = createService({repository:createPostgresRepository(db.pool,options),gateway:{productId:'product',
    checkoutUrl:ref=>`https://checkout.example/?ref=${ref}`,verifyCompleted:async()=>{throw new Error('unused');}}});
  const created = await service.createOrder({userId:buyer},results[0].id);
  if(created.kind!=='payment_required')throw new Error('missing fixture order');
  orderId=created.orderId;reference=new URL(created.checkoutUrl).searchParams.get('ref')!;
  // Verifier contract fixture: real raw HMAC/validation is covered by tests/a/groble-events.test.ts.
  inbox=createGrobleInbox({pool:db.pool,verify:parse,transaction:options});
});
it('commits the event, delivery, payment and order together',async()=>{
  expect(await deliver(event('complete'))).toMatchObject({state:'applied',orderId});
  expect(await status()).toBe('fulfilled');
  for(const table of ['private.groble_events','private.groble_deliveries','public.payments'])
    expect(await scalar(`select count(*)::int as value from ${table}`)).toBe(1);
});
it('concurrent identical delivery grants one payment and one event',async()=>{
  await Promise.all(Array.from({length:8},()=>deliver(event('same'))));
  expect(await scalar('select count(*)::int as value from private.groble_events')).toBe(1);
  expect(await scalar('select count(*)::int as value from public.payments')).toBe(1);
});
it('same event can register a new delivery key without another payment',async()=>{
  await deliver(event('same'));await deliver({...event('same'),idempotencyKey:'another-key'});
  expect(await scalar('select count(*)::int as value from private.groble_deliveries')).toBe(2);
  expect(await scalar('select count(*)::int as value from public.payments')).toBe(1);
});
it('conflicting event payload rolls back the new delivery',async()=>{
  await deliver(event('same'));
  await expect(deliver({...event('same'),reference:'other-reference',idempotencyKey:'conflict-key'} as GroblePaymentEvent)).rejects.toMatchObject({code:'INVALID_WEBHOOK'});
  expect(await scalar('select count(*)::int as value from private.groble_deliveries')).toBe(1);
});
it('a reused delivery key cannot bind to a different event',async()=>{
  await deliver(event('first'));
  await expect(deliver({...event('second'),idempotencyKey:'key-first'})).rejects.toMatchObject({code:'INVALID_WEBHOOK'});
  expect(await scalar('select count(*)::int as value from private.groble_events')).toBe(1);
});
it('stores unmapped refund then applies it atomically when completion arrives',async()=>{
  expect(await deliver(event('refund','payment.refunded'))).toMatchObject({state:'pending_mapping',orderId:null});
  expect(await status()).toBe('pending');
  await deliver(event('complete'));
  expect(await status()).toBe('refunded');
  expect(await scalar("select count(*)::int as value from private.groble_events where state='pending_mapping'")).toBe(0);
  await deliver(event('complete'));
  expect(await status()).toBe('refunded');
});
it('completion racing with refund cannot resurrect a refunded order',async()=>{
  await Promise.all([deliver(event('complete')),deliver(event('refund','payment.refunded'))]);
  expect(await status()).toBe('refunded');
});
it('a cancellation request alone preserves access and creates no refund',async()=>{
  await deliver(event('complete'));
  expect(await deliver(event('cancel','payment.cancel_requested'))).toMatchObject({state:'applied'});
  expect(await status()).toBe('fulfilled');
  expect(await scalar('select count(*)::int as value from private.groble_refunds')).toBe(0);
});
it('refunds with new event IDs still count once by transaction and refunded time',async()=>{
  await deliver(event('complete'));
  await deliver(event('refund1','payment.refunded'));await deliver(event('refund2','payment.refunded'));
  expect(await scalar('select sum(amount)::int as value from private.groble_refunds')).toBe(500);
  expect(await status()).toBe('refunded');
});
it('partial refund needs review and does not invent an access policy',async()=>{
  await deliver(event('complete'));
  const refund = {...event('partial','payment.refunded'),refundAmount:200,partialRefund:true} as GroblePaymentEvent;
  expect(await deliver(refund)).toMatchObject({state:'review_required'});
  expect(await status()).toBe('fulfilled');
});
it('distinct partial refunds reaching the total record a full refund',async()=>{
  await deliver(event('complete'));
  await deliver({...event('p1','payment.refunded'),refundAmount:200,partialRefund:true} as GroblePaymentEvent);
  await deliver({...event('p2','payment.refunded'),refundAmount:300,partialRefund:true,refundedAt:'2026-11-25T12:02:00Z',
    refundDeduplicationKey:JSON.stringify([merchant,'2026-11-25T12:02:00.000Z'])} as GroblePaymentEvent);
  expect(await status()).toBe('refunded');
});
it('conflicting duplicate refund amount rolls back its event',async()=>{
  await deliver(event('complete'));await deliver(event('refund','payment.refunded'));
  await expect(deliver({...event('conflict','payment.refunded'),refundAmount:200,partialRefund:true} as GroblePaymentEvent)).rejects.toMatchObject({code:'INVALID_WEBHOOK'});
  expect(await scalar('select count(*)::int as value from private.groble_events')).toBe(2);
});
it('refund after acceptance preserves the existing room but rejects new request entitlement',async()=>{
  await deliver(event('complete'));const request=await service.requestChat({userId:buyer},orderId);
  const room=await service.acceptChat({userId:target},request.id);
  await deliver(event('refund','payment.refunded'));
  await expect(service.requestChat({userId:buyer},orderId)).rejects.toMatchObject({code:'FORBIDDEN'});
  const message=await service.sendMessage({userId:buyer},room.conversationId,'existing conversation');
  expect(message.body).toBe('existing conversation');
});
it('failed commit work rolls back the inbox and payment together',async()=>{
  const failing=createGrobleInbox({verify:parse,transaction:options,pool:{async connect(){
    const client=await db.pool.connect();
    const query = new Proxy(client.query.bind(client), { apply(fn, thisArg, args) {
      if (typeof args[0] === 'string' && args[0].startsWith('update private.groble_events'))
        throw new Error('fixture failure after payment update');
      return Reflect.apply(fn, thisArg, args);
    }});
    return {query,release:(discard?:boolean)=>client.release(discard)};
  }}});
  await expect(deliver(event('complete'),failing)).rejects.toThrow('fixture failure');
  expect(await status()).toBe('pending');
  expect(await scalar('select count(*)::int as value from private.groble_events')).toBe(0);
  expect(await scalar('select count(*)::int as value from public.payments')).toBe(0);
});
it('invalid authentication does not open a database transaction',async()=>{
  const instance=createGrobleInbox({verify:async()=>{throw new Error('invalid signature');},pool:{connect:async()=>{throw new Error('database must not open');}}});
  await expect(instance.receive(new Uint8Array(),new Headers())).rejects.toThrow('invalid signature');
});
it('normal authenticated users cannot read or write the private event ledger',async()=>{
  const client=await db.pool.connect();
  try {
    await client.query('begin');await client.query('set local role authenticated');
    await expect(client.query('select * from private.groble_events')).rejects.toMatchObject({code:'42501'});
  } finally {await client.query('rollback');client.release();}
});

it('refund totals above the price require review and cannot grant rights on late completion',async()=>{
  await deliver(event('full','payment.refunded'));
  await deliver({...event('extra','payment.refunded'),refundAmount:100,partialRefund:true,
    refundedAt:'2026-11-25T12:02:00Z',refundDeduplicationKey:JSON.stringify([merchant,'2026-11-25T12:02:00.000Z'])} as GroblePaymentEvent);
  await deliver(event('complete'));
  expect(await status()).toBe('refunded');
  expect(await scalar("select count(*)::int as value from private.groble_events where state='review_required'")).toBe(2);
});
it('unknown completion order rolls back the entire event',async()=>{
  await expect(deliver({...event('unknown'),reference:'not-an-order'} as GroblePaymentEvent)).rejects.toMatchObject({code:'INVALID_REQUEST'});
  expect(await scalar('select count(*)::int as value from private.groble_events')).toBe(0);
});
it('full refund before recipient acceptance prevents accepting the pending request',async()=>{
  await deliver(event('complete'));const request=await service.requestChat({userId:buyer},orderId);
  await deliver(event('refund','payment.refunded'));
  await expect(service.acceptChat({userId:target},request.id)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(await scalar('select count(*)::int as value from public.conversations')).toBe(0);
});

it('HTTP success is returned only with committed event and payment rows',async()=>{
  const handler=createGrobleWebhookHandler({receive:inbox.receive});
  const response=await handler(new Request('https://app.example.test/api/webhooks/groble',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event('http-complete')),
  }));
  expect(response.status).toBe(200);
  expect(await status()).toBe('fulfilled');
  expect(await scalar('select count(*)::int as value from public.payments')).toBe(1);
  expect(await scalar("select state as value from private.groble_events where event_id='http-complete'")).toBe('applied');
});
it('HTTP accepts a durably stored early refund and late completion leaves the order refunded',async()=>{
  const handler=createGrobleWebhookHandler({receive:inbox.receive});
  const send=(value:GroblePaymentEvent)=>handler(new Request('https://app.example.test/api/webhooks/groble',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),
  }));
  expect((await send(event('http-refund','payment.refunded'))).status).toBe(202);
  expect(await scalar("select state as value from private.groble_events where event_id='http-refund'")).toBe('pending_mapping');
  expect((await send(event('http-complete'))).status).toBe(200);
  expect(await status()).toBe('refunded');
});
