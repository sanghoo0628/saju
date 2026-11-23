import test from "node:test";
import assert from "node:assert/strict";
import { createMessageTimeline } from "../src/message-timeline.ts";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";

const message=(n:number,room="room-1"):ChatMessage=>({id:`message-${String(n).padStart(4,"0")}`,conversationId:room,senderId:"alice",body:`내용 ${n}`,createdAt:new Date(1794826800000+n*1000).toISOString()});

test("전송 응답과 실시간 이벤트가 중복돼도 한 메시지만 표시한다",()=>{
  const feed=createMessageTimeline("room-1");
  feed.receive(message(1)); feed.receive(message(1));
  feed.appendHistory([message(1)],feed.nextHistoryPage());
  assert.deepEqual(feed.snapshot().messages,[message(1)]);
});

test("역순 실시간 이벤트도 시간과 ID 기준으로 정렬한다",()=>{
  const feed=createMessageTimeline("room-1");
  feed.receive(message(3));feed.receive(message(1));feed.receive(message(2));
  assert.deepEqual(feed.snapshot().messages.map(x=>x.id),[1,2,3].map(n=>message(n).id));
});

test("같은 밀리초 안의 메시지도 DB의 마이크로초 순서를 유지한다",()=>{
  const feed=createMessageTimeline("room-1");
  const earlier={...message(9),body:"earlier",createdAt:"2026-11-23T00:00:00.000001Z"};
  const later={...message(1),body:"later",createdAt:"2026-11-23T00:00:00.000002Z"};
  feed.receive(later);feed.appendHistory([earlier,later],feed.nextHistoryPage());
  assert.deepEqual(feed.snapshot().messages.map(value=>value.body),["earlier","later"]);
});

test("실시간 최신 메시지를 받아도 DB 과거 기록 커서를 건너뛰지 않는다",()=>{
  const feed=createMessageTimeline("room-1");
  feed.receive(message(300));
  const first=feed.nextHistoryPage();
  assert.equal(first.afterId,undefined);
  feed.appendHistory(Array.from({length:100},(_,i)=>message(i+1)),first);
  assert.equal(feed.snapshot().historyCursor,message(100).id);
  assert.equal(feed.snapshot().historyComplete,false);
  const second=feed.nextHistoryPage();
  feed.appendHistory([message(101)],second);
  assert.equal(feed.snapshot().historyComplete,true);
  assert.equal(feed.snapshot().messages.length,102);
});

test("다른 방과 잘못된 실시간 이벤트는 표시하지 않는다",()=>{
  const feed=createMessageTimeline("room-1");
  for(const value of [message(1,"other"),null,{}, {...message(1),createdAt:"invalid"}])
    assert.equal(feed.receive(value),false);
  assert.deepEqual(feed.snapshot().messages,[]);
});

test("연결 복구 이전의 늦은 조회 응답은 새 커서를 덮어쓰지 않는다",()=>{
  const feed=createMessageTimeline("room-1"), stale=feed.nextHistoryPage();
  feed.receive(message(3));feed.restartHistory();
  assert.equal(feed.appendHistory([message(1)],stale),false);
  const current=feed.nextHistoryPage();
  assert.equal(feed.appendHistory([message(1),message(2)],current),true);
  assert.deepEqual(feed.snapshot().messages,[message(1),message(2),message(3)]);
});

test("같은 페이지의 중복 응답과 순서가 뒤집힌 응답을 무시한다",()=>{
  const feed=createMessageTimeline("room-1"), token=feed.nextHistoryPage();
  assert.equal(feed.appendHistory([message(1)],token),true);
  assert.equal(feed.appendHistory([message(2)],token),false);
  assert.deepEqual(feed.snapshot().messages,[message(1)]);
});

test("잘못된 방의 기록 배치는 기존 기록과 커서를 변경하지 않는다",()=>{
  const feed=createMessageTimeline("room-1"), token=feed.nextHistoryPage();
  assert.throws(()=>feed.appendHistory([message(1),message(2,"other")],token),/올바르지/);
  assert.deepEqual(feed.snapshot(),{messages:[],historyCursor:undefined,historyComplete:false});
});

test("외부 객체 수정은 화면 내부 기록을 바꾸지 않고 clear는 잔존 데이터를 제거한다",()=>{
  const feed=createMessageTimeline("room-1"), incoming=message(1);
  feed.receive(incoming);incoming.body="외부 수정";
  const snapshot=feed.snapshot();snapshot.messages[0]!.body="화면 수정";
  assert.equal(feed.snapshot().messages[0]!.body,"내용 1");
  const stale=feed.nextHistoryPage();feed.clear();
  assert.equal(feed.appendHistory([message(2)],stale),false);
  assert.deepEqual(feed.snapshot().messages,[]);
});
