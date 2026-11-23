import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageSendTracker, PendingMessageError } from '../src/message-send-tracker.ts';
import type { ChatMessage } from '../../../contracts/payment-chat.ts';
const KEY='40000000-0000-4000-8000-000000000001';
const NEXT='40000000-0000-4000-8000-000000000002';
const delivered=(changes:Partial<ChatMessage>={}):ChatMessage=>({id:KEY,senderId:'alice',conversationId:'room',body:'hello',createdAt:'2026-11-23T00:00:00.000Z',...changes});

test('retry retains the nonce and original trimmed body',()=>{
  let generated=0;const tracker=createMessageSendTracker('alice','room',()=>{generated++;return KEY;});
  assert.deepEqual(tracker.prepare(' hello '),tracker.prepare('hello'));
  assert.equal(generated,1);
});
test('editing an unresolved send cannot change the payload under the same ID',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);tracker.prepare('hello');
  assert.throws(()=>tracker.prepare('changed'),PendingMessageError);
  assert.equal(tracker.pending()!.body,'hello');
});
test('history or Realtime acknowledgement releases the pending send',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);tracker.prepare('hello');
  assert.equal(tracker.confirm(delivered())!.clientMessageId,KEY);
  assert.equal(tracker.pending(),undefined);
});
test('a lost HTTP response after Realtime confirmation can still be recognized',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);const attempt=tracker.prepare('hello');
  tracker.confirm(delivered());assert.equal(tracker.matches(attempt,delivered()),true);
});
test('wrong ID, sender, room or body cannot clear the pending send',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);tracker.prepare('hello');
  for(const changes of [{id:NEXT},{senderId:'bob'},{conversationId:'other'},{body:'changed'}])assert.equal(tracker.confirm(delivered(changes)),undefined);
  assert.equal(tracker.pending()!.clientMessageId,KEY);
});
test('the same text after acknowledgement gets a new ID',()=>{
  const ids=[KEY,NEXT];const tracker=createMessageSendTracker('alice','room',()=>ids.shift()!);
  tracker.prepare('hello');tracker.confirm(delivered());assert.equal(tracker.prepare('hello').clientMessageId,NEXT);
});
test('snapshots cannot change internal pending data',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);const attempt=tracker.prepare('hello');
  attempt.body='tampered';tracker.pending()!.body='also tampered';assert.equal(tracker.pending()!.body,'hello');
});
test('unmount disposes pending text and rejects late acknowledgements or new sends',()=>{
  const tracker=createMessageSendTracker('alice','room',()=>KEY);const attempt=tracker.prepare('hello');tracker.dispose();
  assert.equal(tracker.pending(),undefined);assert.equal(tracker.confirm(delivered()),undefined);
  assert.equal(tracker.matches(attempt,delivered()),false);assert.throws(()=>tracker.prepare('hello'));
});
test('invalid local UUID generators do not create a pending attempt',()=>{
  const tracker=createMessageSendTracker('alice','room',()=> 'invalid');assert.throws(()=>tracker.prepare('hello'));assert.equal(tracker.pending(),undefined);
});
