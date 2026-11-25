import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createGrobleWebhookHandler } from '../../src/server/groble-webhook-handler';
import { createGrobleEventVerifier } from '../../src/server/groble-events';
import { ServiceError } from '../../packages/payment-chat/src/service';
import type { GrobleInboxResult } from '../../src/server/groble-inbox';

const url = 'https://app.example.test/api/webhooks/groble';
const result: GrobleInboxResult = {eventId:'evt',state:'applied',orderId:'fixture-order'};
const request = (body: BodyInit | null = '{}', headers: Record<string,string> = {}) => new Request(url, {
  method:'POST', headers:{'Content-Type':'application/json',...headers},body,
  ...(body instanceof ReadableStream ? {duplex:'half' as const} : {}),
});
const never = () => { throw new Error('must not reach storage'); };

test('applied commit returns minimal non-cacheable acknowledgement without auth cookies or Origin', async()=>{
  const handler=createGrobleWebhookHandler({receive:async()=>result});
  const response=await handler(request());
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{code:'EVENT_RECEIVED'});
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
});
test('handler does not acknowledge a transaction until its commit promise resolves', async()=>{
  let release!: (result: GrobleInboxResult)=>void;
  const committed=new Promise<GrobleInboxResult>(resolve=>{release=resolve;});
  let entered!: ()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  const handler=createGrobleWebhookHandler({receive:()=>{entered();return committed;}});
  let acknowledged=false;const pending=handler(request()).then(r=>{acknowledged=true;return r;});
  await started;assert.equal(acknowledged,false);release(result);
  assert.equal((await pending).status,200);
});
for(const state of ['pending_mapping','review_required'] as const)test('durable '+state+' is accepted without exposing internal IDs',async()=>{
  const response=await createGrobleWebhookHandler({receive:async()=>({...result,state})})(request());
  assert.equal(response.status,202);assert.equal((await response.text()).includes('fixture-order'),false);
});
test('rollback or unavailable DB is retryable and cannot return a success acknowledgement',async()=>{
  let calls=0;const failure=new Error('postgresql://private:credential@db/payload');
  const handler=createGrobleWebhookHandler({receive:async()=>{throw failure;},onUnexpectedError:error=>{assert.equal(error,failure);calls++;}});
  const response=await handler(request());assert.equal(response.status,503);
  assert.equal(response.headers.get('Retry-After'),'5');assert.equal((await response.text()).includes('credential'),false);assert.equal(calls,1);
});
test('a throwing diagnostics callback cannot change a failed-store response',async()=>{
  const response=await createGrobleWebhookHandler({receive:async()=>{throw new Error('private');},onUnexpectedError:never})(request());
  assert.equal(response.status,503);
});
for(const code of ['INVALID_WEBHOOK','INVALID_REQUEST'] as const)test('invalid signed input maps to final 400: '+code,async()=>{
  const response=await createGrobleWebhookHandler({receive:async()=>{throw new ServiceError(code,'private reason');}})(request());
  assert.equal(response.status,400);assert.deepEqual(await response.json(),{code:'INVALID_WEBHOOK'});
});
test('unexpected inbox return cannot accidentally acknowledge uncommitted work',async()=>{
  const response=await createGrobleWebhookHandler({receive:async()=>({...result,state:'unknown' as GrobleInboxResult['state']})})(request());
  assert.equal(response.status,503);
});
for(const method of ['GET','PUT','OPTIONS'])test('wrong method does not touch storage: '+method,async()=>{
  const response=await createGrobleWebhookHandler({receive:never})(new Request(url,{method}));
  assert.equal(response.status,405);assert.equal(response.headers.get('Allow'),'POST');
});
test('unrelated path does not touch storage',async()=>{
  const response=await createGrobleWebhookHandler({receive:never})(new Request('https://app.example.test/api/other',{method:'POST'}));
  assert.equal(response.status,404);
});
for(const type of ['text/plain','application/x-www-form-urlencoded',''])test('only JSON media is accepted: '+type,async()=>{
  const response=await createGrobleWebhookHandler({receive:never})(request('{}',{'Content-Type':type}));assert.equal(response.status,415);
});
for(const body of [null,''])test('empty body is rejected before storage: '+String(body),async()=>{
  assert.equal((await createGrobleWebhookHandler({receive:never})(request(body))).status,400);
});
test('declared oversize request is rejected before consuming its stream',async()=>{
  const response=await createGrobleWebhookHandler({receive:never})(request('{}',{'Content-Length':String(256*1024+1)}));assert.equal(response.status,413);
});
test('actual streamed body is capped even when Content-Length lies',async()=>{
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(256*1024+1));},cancel(){cancelled=true;}});
  assert.equal((await createGrobleWebhookHandler({receive:never})(request(stream,{'Content-Length':'1'}))).status,413);
  assert.equal(cancelled,true);
});
test('exact raw bytes and signature headers reach the verifier without JSON serialization',async()=>{
  const raw='  {"a":1}\n';
  const response=await createGrobleWebhookHandler({receive:async(bytes,headers)=>{
    assert.equal(Buffer.from(bytes).toString(),raw);assert.equal(headers.get('x-groble-signature'),'fixture-signature');return result;
  }})(request(raw,{'X-Groble-Signature':'fixture-signature','Content-Type':'application/json; charset=utf-8'}));
  assert.equal(response.status,200);
});
test('stalled upload times out and cancels without calling persistence',async()=>{
  let cancelled=false;const stream=new ReadableStream({cancel(){cancelled=true;}});
  const response=await createGrobleWebhookHandler({receive:never,readTimeoutMs:15})(request(stream));
  assert.equal(response.status,408);assert.equal(cancelled,true);
});
test('valid authenticated completion reaches persistence boundary and invalid signature never does',async()=>{
  const secret='fixture-secret',now=1795510000000,timestamp=String(now/1000);
  const verify=createGrobleEventVerifier({productId:'product',secret,now:()=>now});
  const payload={id:'evt',type:'payment.completed',version:'2026-04-30',occurredAt:'2026-11-25T12:00:00Z',data:{object:{
    merchantUid:'merchant',sellerReference:'opaque-ref',content:{id:'product',paymentType:'ONE_TIME'},pricing:{currency:'KRW',finalAmount:500},
  }}};
  const raw=JSON.stringify(payload);const signature=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest('hex');
  let stores=0;const handler=createGrobleWebhookHandler({receive:async(bytes,headers)=>{
    const event=await verify(bytes,headers);assert.equal(event.type,'payment.completed');stores++;return result;
  }});
  const headers={'X-Groble-Timestamp':timestamp,'X-Groble-Signature':signature,'X-Groble-Idempotency-Key':'delivery'};
  assert.equal((await handler(request(raw,headers))).status,200);
  assert.equal((await handler(request(raw,{...headers,'X-Groble-Signature':'0'.repeat(64)}))).status,400);
  assert.equal(stores,1);
});
