import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, alice, bob, eve, denied } from './fixtures.ts';
import { createBrowserClient } from '../src/client.ts';
import { createHttpApi } from '../src/http.ts';
import { createMessageSendTracker } from '../src/message-send-tracker.ts';

const KEY='40000000-0000-4000-8000-000000000001';
const SECOND='40000000-0000-4000-8000-000000000002';

test('same sender, room and normalized body return the original message and timestamp', async () => {
  const f=fixture(), room=await f.room();
  const first=await f.service.sendMessage(alice,room,'  hello  ',KEY);
  assert.deepEqual(await f.service.sendMessage(alice,room,'hello',KEY),first);
  assert.equal(f.state.messages.length,1);
  assert.equal(first.id,KEY);
});
test('reusing a key with different text does not overwrite or append', async () => {
  const f=fixture(), room=await f.room();
  await f.service.sendMessage(alice,room,'original',KEY);
  await assert.rejects(f.service.sendMessage(alice,room,'changed',KEY),denied('INVALID_REQUEST'));
  assert.equal(f.state.messages.length,1);
  assert.equal(f.state.messages[0]!.body,'original');
});
test('another participant cannot claim an existing message ID', async () => {
  const f=fixture(), room=await f.room();
  await f.service.sendMessage(alice,room,'original',KEY);
  await assert.rejects(f.service.sendMessage(bob,room,'original',KEY),denied('INVALID_REQUEST'));
  assert.equal(f.state.messages[0]!.senderId,alice.userId);
});
test('a sender cannot move an existing ID into a different room', async () => {
  const f=fixture(), room=await f.room();
  await f.service.sendMessage(alice,room,'original',KEY);
  const request=await f.service.requestChat(alice,await f.paid('a-c'));
  const other=await f.service.acceptChat({userId:'carol'},request.id);
  await assert.rejects(f.service.sendMessage(alice,other.conversationId,'original',KEY),denied('INVALID_REQUEST'));
  assert.equal(f.state.messages.length,1);
});
test('replays recheck membership and both directions of blocking', async () => {
  const f=fixture(), room=await f.room();
  await f.service.sendMessage(alice,room,'original',KEY);
  await assert.rejects(f.service.sendMessage(eve,room,'original',KEY),denied('FORBIDDEN'));
  f.state.blocks.push([bob.userId,alice.userId]);
  await assert.rejects(f.service.sendMessage(alice,room,'original',KEY),denied('BLOCKED'));
});
test('distinct keys and legacy sends remain distinct intentional messages', async () => {
  const f=fixture(), room=await f.room();
  const messages=await Promise.all([
    f.service.sendMessage(alice,room,'hello',KEY), f.service.sendMessage(alice,room,'hello',SECOND),
    f.service.sendMessage(alice,room,'hello'), f.service.sendMessage(alice,room,'hello'),
  ]);
  assert.equal(new Set(messages.map(m=>m.id)).size,4);
});
test('invalid client IDs fail before inserting', async () => {
  const f=fixture(), room=await f.room();
  for(const id of ['', 'not-a-uuid','F0000000-0000-4000-8000-000000000001','40000000-0000-1000-8000-000000000001'])
    await assert.rejects(f.service.sendMessage(alice,room,'hello',id),denied('INVALID_REQUEST'));
  assert.equal(f.state.messages.length,0);
});
test('a lost POST response can be retried through the browser client without a second write', async () => {
  const f=fixture(), room=await f.room(), origin='https://chat.example';
  const handler=createHttpApi({service:f.service,appOrigin:origin,getCurrentUserId:async()=>alice.userId});
  let drop=true;
  const api=createBrowserClient(async (path,options)=>{
    const response=await handler(new Request(new URL(String(path),origin),{...options,headers:{...Object.fromEntries(new Headers(options?.headers)),origin}}));
    if(options?.method==='POST'&&drop) {drop=false;assert.equal(response.status,200);throw new TypeError('Simulated response loss after commit');}
    return response;
  });
  const tracker=createMessageSendTracker(alice.userId,room,()=>KEY);
  const attempt=tracker.prepare('hello');
  await assert.rejects(api.sendMessage(room,attempt.body,undefined,attempt.clientMessageId),TypeError);
  const again=tracker.prepare('hello');
  assert.equal(again.clientMessageId,attempt.clientMessageId);
  const result=await api.sendMessage(room,again.body,undefined,again.clientMessageId);
  assert.ok(tracker.confirm(result));
  assert.equal(tracker.pending(),undefined);
  assert.equal((await api.messages(room)).length,1);
  assert.equal(f.state.messages.length,1);
});
test('HTTP rejects malformed optional IDs and extra author fields', async () => {
  const f=fixture(), room=await f.room(), origin='https://chat.example';
  const handler=createHttpApi({service:f.service,appOrigin:origin,getCurrentUserId:async()=>alice.userId});
  for(const body of [{body:'hello',clientMessageId:null},{body:'hello',clientMessageId:123},{body:'hello',clientMessageId:''},{body:'hello',clientMessageId:KEY,senderId:'bob'}]) {
    const response=await handler(new Request(`${origin}/api/conversations/${room}/messages`,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}));
    assert.equal(response.status,400);
  }
  assert.equal(f.state.messages.length,0);
});
