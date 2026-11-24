import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createGrobleGateway } from '../../src/server/groble-gateway';
import { ConfigurationError } from '../../src/lib/env/schema';
import { ServiceError } from '../../packages/payment-chat/src/service';
import { createService } from '../../packages/payment-chat/src/service';
import { createHttpApi } from '../../packages/payment-chat/src/http';
import { fixture, alice } from '../../packages/payment-chat/test/fixtures';

const timestamp = 1795510000;
const secret = 'test-only-current-webhook-secret';
const previousSecret = 'test-only-previous-webhook-secret';
const options = { paymentUrl:'https://groble.im/payment/test-product?campaign=demo',productId:'encoded-product',secret,now:()=>timestamp*1000 };
function event() { return {id:'evt_test',type:'payment.completed',version:'2026-04-30',occurredAt:'2026-11-24T12:00:00+09:00',data:{object:{
  merchantUid:'merchant_test',sellerReference:'opaque-order-reference',content:{id:'encoded-product',paymentType:'ONE_TIME'},pricing:{currency:'KRW',finalAmount:500},
}}}; }
function signed(raw:Uint8Array,key=secret,time=String(timestamp)) {
  const signature=createHmac('sha256',key).update(Buffer.concat([Buffer.from(`${time}.`),Buffer.from(raw)])).digest('hex');
  return new Headers({'X-Groble-Timestamp':time,'X-Groble-Signature':signature,'X-Groble-Idempotency-Key':'delivery-test'});
}
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const rejected=(error:unknown)=>error instanceof ServiceError&&error.code==='INVALID_WEBHOOK';

test('checkout URL preserves existing parameters and uses only the opaque order reference',()=>{
  const url=new URL(createGrobleGateway(options).checkoutUrl('order_123-abc'));
  assert.equal(url.searchParams.get('campaign'),'demo');assert.equal(url.searchParams.get('ref'),'order_123-abc');
});
for(const reference of ['email@example.test','한글','a/b','a+b','a'.repeat(129),'']) {
  test(`invalid checkout reference is rejected (${reference.length} chars)`,()=>assert.throws(()=>createGrobleGateway(options).checkoutUrl(reference),ServiceError));
}
for(const paymentUrl of ['http://groble.im/payment/test','https://groble.im.evil.test/payment/test','https://user:password@groble.im/payment/test','https://groble.im/other/test']) {
  test('checkout host and route configuration fail closed: '+new URL(paymentUrl).hostname,()=>assert.throws(()=>createGrobleGateway({...options,paymentUrl}),ConfigurationError));
}
test('official envelope maps merchantUid to the stored payment identifier without buyer data',async()=>{
  const payload={...event(),extra:'future field',data:{object:{...event().data.object,buyer:{email:'private@example.test'}}}};
  const raw=bytes(payload);
  assert.deepEqual(await createGrobleGateway(options).verifyCompleted(raw,signed(raw)),{reference:'opaque-order-reference',transactionId:'merchant_test',productId:'encoded-product',amount:500,currency:'KRW'});
});
test('signature verification uses exact raw bytes including whitespace',async()=>{
  const raw=new TextEncoder().encode(' '+JSON.stringify(event())+'\n');
  const gateway=createGrobleGateway(options);
  assert.equal((await gateway.verifyCompleted(raw,signed(raw))).amount,500);
  await assert.rejects(gateway.verifyCompleted(bytes(event()),signed(raw)),rejected);
});
test('current and previous headers/keys support the documented rotation window',async()=>{
  const raw=bytes(event()),headers=signed(raw);
  headers.set('X-Groble-Signature','0'.repeat(64));
  headers.set('X-Groble-Signature-Previous',signed(raw,previousSecret).get('X-Groble-Signature')!);
  assert.equal((await createGrobleGateway({...options,previousSecret,previousSecretExpiresAt:(timestamp+86400)*1000}).verifyCompleted(raw,headers)).transactionId,'merchant_test');
  await assert.rejects(createGrobleGateway(options).verifyCompleted(raw,headers),rejected);
});
test('an old secret is rejected after its explicit rotation deadline',async()=>{
  const raw=bytes(event()),later=timestamp+86401,headers=signed(raw,secret,String(later));
  headers.set('X-Groble-Signature','0'.repeat(64));
  headers.set('X-Groble-Signature-Previous',signed(raw,previousSecret,String(later)).get('X-Groble-Signature')!);
  await assert.rejects(createGrobleGateway({...options,now:()=>later*1000,previousSecret,previousSecretExpiresAt:(timestamp+86400)*1000}).verifyCompleted(raw,headers),rejected);
  assert.throws(()=>createGrobleGateway({...options,previousSecret}),ConfigurationError);
});
for(const delta of [-301,301])test('timestamps outside the five-minute window are rejected: '+delta,async()=>{
  const raw=bytes(event());await assert.rejects(createGrobleGateway(options).verifyCompleted(raw,signed(raw,secret,String(timestamp+delta))),rejected);
});
for(const header of ['X-Groble-Signature','X-Groble-Timestamp','X-Groble-Idempotency-Key'])test('missing required '+header+' fails before crediting',async()=>{
  const raw=bytes(event()),headers=signed(raw);headers.delete(header);
  await assert.rejects(createGrobleGateway(options).verifyCompleted(raw,headers),rejected);
});
for(const change of [
  (value:ReturnType<typeof event>)=>{value.data.object.pricing.finalAmount=499;},
  (value:ReturnType<typeof event>)=>{value.data.object.pricing.currency='USD';},
  (value:ReturnType<typeof event>)=>{value.data.object.content.id='other-product';},
  (value:ReturnType<typeof event>)=>{value.type='payment.refunded';},
  (value:ReturnType<typeof event>)=>{value.data.object.sellerReference='';},
])test('a signed but incompatible payment cannot grant rights',async()=>{
  const value=event();change(value);const raw=bytes(value);
  await assert.rejects(createGrobleGateway(options).verifyCompleted(raw,signed(raw)),rejected);
});
test('malformed authenticated JSON is rejected without leaking payload content',async()=>{
  const raw=new TextEncoder().encode('{"private":"malformed');
  await assert.rejects(createGrobleGateway(options).verifyCompleted(raw,signed(raw)),error=>rejected(error)&&!(error as Error).message.includes('private'));
});

test('signed Groble completion reaches the service without a login cookie and replays only once',async()=>{
  const f=fixture(),gateway=createGrobleGateway(options),service=createService({repository:f.repository,gateway});
  const created=await service.createOrder(alice,'a-b');
  if(created.kind!=='payment_required')throw new Error('order missing');
  const reference=new URL(created.checkoutUrl).searchParams.get('ref')!;
  const value=event();value.data.object.sellerReference=reference;
  const raw=bytes(value),headers=signed(raw);
  const api=createHttpApi({service,appOrigin:'https://app.example.test',getCurrentUserId:async()=>{throw new Error('webhooks cannot depend on user cookies');}});
  for(let i=0;i<2;i++){
    const response=await api(new Request('https://app.example.test/api/webhooks/groble',{method:'POST',headers,body:raw}));
    assert.equal(response.status,200);
    assert.equal((await response.json()).status,'fulfilled');
  }
  assert.equal(f.state.orders[0]!.userId,alice.userId);
  assert.equal(f.state.payments.length,1);
  assert.equal(f.state.payments[0]!.transactionId,'merchant_test');
});

test('an invalid Groble signature cannot change an actual pending order',async()=>{
  const f=fixture(),service=createService({repository:f.repository,gateway:createGrobleGateway(options)});
  const created=await service.createOrder(alice,'a-b');
  if(created.kind!=='payment_required')throw new Error('order missing');
  const value=event();value.data.object.sellerReference=new URL(created.checkoutUrl).searchParams.get('ref')!;
  const raw=bytes(value),headers=signed(raw);headers.set('X-Groble-Signature','f'.repeat(64));
  const api=createHttpApi({service,appOrigin:'https://app.example.test',getCurrentUserId:async()=>null});
  const response=await api(new Request('https://app.example.test/api/webhooks/groble',{method:'POST',headers,body:raw}));
  assert.equal(response.status,400);
  assert.equal(f.state.orders[0]!.status,'pending');
  assert.equal(f.state.payments.length,0);
});
