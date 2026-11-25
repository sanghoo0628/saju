import { beforeAll,beforeEach,afterAll,it,expect,vi } from 'vitest';
// This test executes in a server process; no browser bundling or environment access is mocked.
vi.mock('server-only',()=>({}));
import { createHmac } from 'node:crypto';
import { createGroblePaymentChatModule } from '../../src/server/groble-module';
import { startNativePostgres } from './native-postgres';
import { seedUsers,uid } from '../db/harness';
const buyer=uid(1),recipient=uid(2),origin='https://app.example.test',now=1795510000000;
const source={PAYMENTS_ENABLED:'true',GROBLE_PAYMENT_URL:'https://groble.im/payment/fixture',GROBLE_PRODUCT_ID:'product',GROBLE_WEBHOOK_SECRET:'fixture-only-secret'};
let db:Awaited<ReturnType<typeof startNativePostgres>>,matchId:string,activeUser:string,authCalls:number;
const assemble=(extra:Record<string,string>={})=>createGroblePaymentChatModule({pool:db.pool,source:{...source,...extra},appOrigin:origin,
  now:()=>now,requireUserId:async()=>{authCalls++;return activeUser;},onUnexpectedError:()=>{}});
type Integration=Awaited<ReturnType<typeof assemble>>;
const post=(path:string,body:unknown)=>new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function create(integration:Integration){
  const response=await integration.handle(post('/api/orders',{matchResultId:matchId}));expect(response.status).toBe(200);
  const order=await response.json();expect(order.kind).toBe('payment_required');
  return {id:order.orderId as string,reference:new URL(order.checkoutUrl).searchParams.get('ref')!};
}
function payload(id:string,type='payment.completed',reference?:string){return {id,type,version:'2026-04-30',occurredAt:'2026-11-25T12:00:00Z',data:{object:{
  merchantUid:'merchant',...(reference?{sellerReference:reference}:{}),content:{id:'product',paymentType:'ONE_TIME'},pricing:{currency:'KRW',finalAmount:500},
  refund:{amount:500,currency:'KRW',partialRefund:false,refundedAt:'2026-11-25T12:01:00Z'},
}}};}
function signed(value:unknown,key=source.GROBLE_WEBHOOK_SECRET){
  const body=JSON.stringify(value),timestamp=String(now/1000);
  const signature=createHmac('sha256',key).update(`${timestamp}.${body}`).digest('hex');
  return new Request(origin+'/api/webhooks/groble',{method:'POST',body,headers:{'Content-Type':'application/json',
    'X-Groble-Timestamp':timestamp,'X-Groble-Signature':signature,'X-Groble-Idempotency-Key':'delivery-'+(value as {id:string}).id}});
}
const scalar=async(sql:string)=>(await db.pool.query(sql)).rows[0].value;
beforeAll(async()=>{db=await startNativePostgres();await db.pool.query(`create schema supabase_migrations;
  create table supabase_migrations.schema_migrations(version text primary key);
  insert into supabase_migrations.schema_migrations values('20261125000100'),('20261125000200')`);},60000);
afterAll(async()=>{if(db)await db.close();},30000);
beforeEach(async()=>{
  await db.pool.query(`truncate private.groble_deliveries,private.groble_events,private.groble_refunds,
    public.messages,public.conversations,public.chat_requests,public.payments,public.orders,public.match_results,auth.users cascade`);
  await seedUsers(db.pool,[{id:buyer,score:1000},{id:recipient,score:-1000}]);
  matchId=(await db.pool.query('select id from public.get_or_create_match_results($1)',[buyer])).rows[0].id;
  activeUser=buyer;authCalls=0;
});
it('composes authenticated order, real HMAC webhook, durable payment and chat acceptance in one module',async()=>{
  const integration=await assemble();expect(integration.enabled).toBe(true);const order=await create(integration);authCalls=0;
  const complete=payload('complete','payment.completed',order.reference);
  expect((await integration.handle(signed(complete))).status).toBe(200);
  expect(authCalls).toBe(0);
  expect((await integration.handle(signed(complete))).status).toBe(200);
  expect(await scalar('select count(*)::int value from public.payments')).toBe(1);
  expect(await scalar('select count(*)::int value from private.groble_events')).toBe(1);
  const request=await integration.handle(post('/api/chat-requests',{orderId:order.id}));expect(request.status).toBe(200);
  activeUser=recipient;const accepted=await integration.handle(post('/api/chat-requests/'+(await request.json()).id+'/accept',{}));expect(accepted.status).toBe(200);
  const {conversationId}=await accepted.json();activeUser=buyer;
  const sent=await integration.handle(post(`/api/conversations/${conversationId}/messages`,{body:'fixture message'}));
  expect(sent.status).toBe(200);expect((await sent.json()).body).toBe('fixture message');
});
it('invalid HMAC cannot reach the durable inbox or authenticate a buyer',async()=>{
  const integration=await assemble(),order=await create(integration);authCalls=0;
  const incoming=signed(payload('bad','payment.completed',order.reference),'wrong-key');
  expect((await integration.handle(incoming)).status).toBe(400);expect(authCalls).toBe(0);
  expect(await scalar('select count(*)::int value from private.groble_events')).toBe(0);
  expect(await scalar('select status value from public.orders')).toBe('pending');
});
it('authenticates refund before completion and prevents late completion from restoring rights',async()=>{
  const integration=await assemble(),order=await create(integration);
  expect((await integration.handle(signed(payload('refund','payment.refunded')))).status).toBe(202);
  expect((await integration.handle(signed(payload('complete','payment.completed',order.reference)))).status).toBe(200);
  expect(await scalar('select status value from public.orders')).toBe('refunded');
  expect((await integration.handle(post('/api/chat-requests',{orderId:order.id}))).status).toBe(403);
});
it('missing timestamp migration blocks assembly and does not run a write migration',async()=>{
  await db.pool.query("delete from supabase_migrations.schema_migrations where version='20261125000200'");
  try {await expect(assemble()).rejects.toMatchObject({fields:['GROBLE_DATABASE_SCHEMA']});
    expect(await scalar('select count(*)::int value from public.orders')).toBe(0);
  } finally {await db.pool.query("insert into supabase_migrations.schema_migrations values('20261125000200')");}
});
it('unexpected browser grants block assembly without silently repairing permissions',async()=>{
  await db.pool.query('grant select on private.groble_events to anon');
  try {await expect(assemble()).rejects.toMatchObject({fields:['GROBLE_DATABASE_SCHEMA']});
    expect(await scalar("select has_table_privilege('anon','private.groble_events','SELECT') value")).toBe(true);
  } finally {await db.pool.query('revoke select on private.groble_events from anon');}
});
it('application POST retains Origin protection',async()=>{
  const integration=await assemble(),req=post('/api/orders',{matchResultId:matchId});req.headers.set('Origin','https://other.example.test');
  expect((await integration.handle(req)).status).toBe(403);expect(authCalls).toBe(0);
  expect(await scalar('select count(*)::int value from public.orders')).toBe(0);
});
it('disabling new payments preserves an existing paid entitlement and blocks webhook completion',async()=>{
  const enabled=await assemble(),order=await create(enabled);
  await enabled.handle(signed(payload('complete','payment.completed',order.reference)));
  const disabled=await assemble({PAYMENTS_ENABLED:'false'});
  const reused=await disabled.handle(post('/api/orders',{matchResultId:matchId}));
  expect((await reused.json()).kind).toBe('chat_available');
  expect((await disabled.handle(signed(payload('disabled','payment.completed',order.reference)))).status).toBe(503);
  expect(await scalar('select count(*)::int value from private.groble_events')).toBe(1);
});
it('active previous key passes the composed verifier and durable storage',async()=>{
  const previous='previous-fixture-secret',integration=await assemble({GROBLE_WEBHOOK_PREVIOUS_SECRET:previous,
    GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT:new Date(now+3600000).toISOString()});
  const order=await create(integration),old=signed(payload('rotation','payment.completed',order.reference),previous);
  old.headers.set('X-Groble-Signature-Previous',old.headers.get('X-Groble-Signature')!);old.headers.set('X-Groble-Signature','0'.repeat(64));
  expect((await integration.handle(old)).status).toBe(200);expect(await scalar('select status value from public.orders')).toBe('fulfilled');
});
it('signed partial refund is stored for review without pretending a full refund',async()=>{
  const integration=await assemble(),order=await create(integration);
  await integration.handle(signed(payload('complete','payment.completed',order.reference)));
  const refund=payload('partial','payment.refunded');refund.data.object.refund.amount=200;refund.data.object.refund.partialRefund=true;
  expect((await integration.handle(signed(refund))).status).toBe(202);
  expect(await scalar("select state value from private.groble_events where event_id='partial'")).toBe('review_required');
  expect(await scalar('select status value from public.orders')).toBe('fulfilled');
});
