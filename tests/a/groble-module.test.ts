import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroblePaymentChatModule } from '../../src/server/groble-module';
import { ConfigurationError } from '../../src/lib/env/schema';
import type { TransactionPool } from '../../src/server/postgres-repository';
const now=1795510000000;
const configured={PAYMENTS_ENABLED:'true',GROBLE_PAYMENT_URL:'https://groble.im/payment/fixture',GROBLE_PRODUCT_ID:'product',GROBLE_WEBHOOK_SECRET:'fixture-secret'};
const base={appOrigin:'https://app.example.test',now:()=>now,requireUserId:async()=>{throw new Error('must not authenticate webhook');}};
function unopened(){let calls=0;return {pool:{connect:async()=>{calls++;throw new Error('connection must remain unused');}} as TransactionPool,calls:()=>calls};}
const request=()=>new Request('https://app.example.test/api/webhooks/groble',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
test('disabled module ignores missing keys, opens no DB and does not authenticate webhook',async()=>{
  const p=unopened(),integration=await createGroblePaymentChatModule({...base,pool:p.pool,source:{PAYMENTS_ENABLED:'false'}});
  assert.equal(integration.enabled,false);assert.equal((await integration.handle(request())).status,503);assert.equal(p.calls(),0);
});
test('disabled module preserves application authentication and unconfigured webhook methods',async()=>{
  const p=unopened();let calls=0;
  const integration=await createGroblePaymentChatModule({...base,pool:p.pool,source:{},requireUserId:async()=>{calls++;return 'user';}});
  assert.equal((await integration.handle(new Request('https://app.example.test/api/unknown'))).status,404);
  assert.equal((await integration.handle(new Request('https://app.example.test/api/webhooks/groble'))).status,405);
  assert.equal(calls,0);assert.equal(p.calls(),0);
});
for(const field of ['GROBLE_PAYMENT_URL','GROBLE_PRODUCT_ID','GROBLE_WEBHOOK_SECRET'])test('enabled module validates '+field+' before connecting',async()=>{
  const p=unopened();await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,source:{...configured,[field]:''}}),ConfigurationError);
  assert.equal(p.calls(),0);
});
for(const value of ['1','TRUE','yes'])test('malformed enable flag does not turn on payments: '+value,async()=>{
  const p=unopened();await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,source:{...configured,PAYMENTS_ENABLED:value}}),ConfigurationError);assert.equal(p.calls(),0);
});
for(const appOrigin of ['http://app.example.test','https://user:private@app.example.test','https://app.example.test/other'])
  test('enabled origin is HTTPS and contains no credentials or path',async()=>{
    const p=unopened();await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,appOrigin,source:configured}),ConfigurationError);assert.equal(p.calls(),0);
  });
for(const change of [
  {GROBLE_WEBHOOK_PREVIOUS_SECRET:'old-secret'},
  {GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT:'2026-11-25T00:00:00Z'},
  {GROBLE_WEBHOOK_PREVIOUS_SECRET:'old-secret',GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT:'not-a-date'},
  {GROBLE_WEBHOOK_PREVIOUS_SECRET:'old-secret',GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT:new Date(now+86400001).toISOString()},
])test('rotation misconfiguration fails before database access',async()=>{
  const p=unopened();await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,source:{...configured,...change}}),ConfigurationError);assert.equal(p.calls(),0);
});
test('preflight failure is bounded and does not expose connection credentials',async()=>{
  const p=unopened();const diagnostics:unknown[]=[];
  await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,source:configured,onUnexpectedError:error=>{diagnostics.push(error);}}),
    error=>error instanceof ConfigurationError&&error.fields.includes('GROBLE_DATABASE_PREFLIGHT')&&!error.message.includes('connection must'));
  assert.equal(p.calls(),1);assert.equal(diagnostics.length,1);
});

test('mock payment flags cannot select an alternative completion path',async()=>{
  const p=unopened();await assert.rejects(createGroblePaymentChatModule({...base,pool:p.pool,
    source:{PAYMENTS_ENABLED:'false',MOCK_PAYMENTS_ENABLED:'true'}}),ConfigurationError);assert.equal(p.calls(),0);
});
