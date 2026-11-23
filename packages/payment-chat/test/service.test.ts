import test from "node:test";
import assert from "node:assert/strict";
import { fixture, alice, bob, eve, denied } from "./fixtures.ts";

test("상대별 500원 주문을 만들며 공개 추천 데이터는 결제로 변경하지 않는다", async () => {
  const f=fixture();
  const first=await f.service.createOrder(alice,"a-b");
  const second=await f.service.createOrder(alice,"a-c");
  assert.equal(first.kind,"payment_required");
  assert.equal(second.kind,"payment_required");
  assert.deepEqual(f.state.orders.map(x=>[x.targetId,x.amountKrw]),[["bob",500],["carol",500]]);
  assert.equal(f.state.results.length,4);
});

test("동일 프로필 동시 클릭은 미결제 주문 하나를 재사용한다", async () => {
  const f=fixture();
  const results=await Promise.all(Array.from({length:8},()=>f.service.createOrder(alice,"a-b")));
  assert.equal(f.state.orders.length,1);
  assert.equal(new Set(results.map(x=>x.kind === "payment_required" && x.orderId)).size,1);
});

test("다른 회원의 추천과 본인 추천에는 주문을 생성하지 않는다", async () => {
  const f=fixture();
  await assert.rejects(f.service.createOrder(eve,"a-b"),denied("FORBIDDEN"));
  f.state.results.push({id:"self",userId:"alice",targetId:"alice"});
  await assert.rejects(f.service.createOrder(alice,"self"),denied("FORBIDDEN"));
  assert.equal(f.state.orders.length,0);
});

test("미결제 주문은 대화 요청을 허용하지 않는다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await assert.rejects(f.service.requestChat(alice,order.orderId),denied("FORBIDDEN"));
});

test("잘못된 서명은 권한과 결제 기록을 생성하지 않는다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await assert.rejects(f.deliver(f.event(order.orderId),false),/invalid signature/);
  assert.equal(f.state.orders[0]!.status,"pending");
  assert.equal(f.state.payments.length,0);
});

test("금액·통화·상품·참조값이 틀린 이벤트를 거부한다", async () => {
  for(const override of [{amount:1},{currency:"USD"},{productId:"other"},{reference:"unknown"}]) {
    const f=fixture(), order=await f.service.createOrder(alice,"a-b");
    if(order.kind!=="payment_required") throw new Error();
    await assert.rejects(f.deliver(f.event(order.orderId,override)),denied("INVALID_REQUEST"));
    assert.equal(f.state.payments.length,0);
  }
});

test("동시 웹훅 재전송에도 결제 기록과 권한은 하나다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  await Promise.all(Array.from({length:10},()=>f.deliver(f.event(order.orderId))));
  assert.equal(f.state.payments.length,1);
  assert.equal(f.state.orders[0]!.status,"fulfilled");
  assert.deepEqual(await f.service.createOrder(alice,"a-b"),{kind:"chat_available",orderId:order.orderId});
});

test("한 결제 식별자를 다른 프로필 주문에 재사용할 수 없다", async () => {
  const f=fixture(), first=await f.paid();
  const second=await f.service.createOrder(alice,"a-c");
  if(second.kind!=="payment_required") throw new Error();
  await assert.rejects(f.deliver(f.event(second.orderId,{transactionId:`payment-${first}`})),denied("INVALID_REQUEST"));
  assert.equal(f.state.orders[1]!.status,"pending");
});

test("결제 중 상대가 비공개되면 대상 변경 없이 환불 대기로 전환한다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  f.state.profiles=f.state.profiles.filter(x=>x!=="bob");
  const result=await f.deliver(f.event(order.orderId));
  assert.equal(result.status,"refund_pending");
  assert.equal((await f.deliver(f.event(order.orderId))).status,"refund_pending");
  assert.equal(f.state.payments.length,1);
  assert.equal(f.state.orders[0]!.targetId,"bob");
  await assert.rejects(f.service.requestChat(alice,order.orderId),denied("FORBIDDEN"));
});

test("주문 조회와 대화 요청은 결제한 사용자만 가능하다", async () => {
  const f=fixture(), id=await f.paid();
  await assert.rejects(f.service.order(eve,id),denied("FORBIDDEN"));
  await assert.rejects(f.service.requestChat(eve,id),denied("FORBIDDEN"));
  assert.equal((await f.service.order(alice,id)).targetId,"bob");
});

test("환불된 주문은 웹훅 재전송으로 대화 권한이 복구되지 않는다", async () => {
  const f=fixture(), id=await f.paid();
  f.state.orders[0]!.status="refunded";
  assert.equal((await f.deliver(f.event(id))).status,"refunded");
  await assert.rejects(f.service.requestChat(alice,id),denied("FORBIDDEN"));
});

test("결제 기록 저장 중 예외가 나면 트랜잭션 전체가 롤백된다", async () => {
  const f=fixture(), order=await f.service.createOrder(alice,"a-b");
  if(order.kind!=="payment_required") throw new Error();
  // payment 저장 후 profile 확인 중 예외가 나게 하여 중간 기록 잔류를 확인한다.
  const profiles=f.state.profiles;
  f.state.profiles=null as unknown as string[];
  await assert.rejects(f.deliver(f.event(order.orderId)));
  assert.equal(f.state.payments.length,0);
  assert.equal(f.state.orders[0]!.status,"pending");
  f.state.profiles=profiles;
});

test("한 상대 결제로 다른 상대와 채팅할 수 없다", async () => {
  const f=fixture(), id=await f.paid();
  const request=await f.service.requestChat(alice,id);
  assert.equal(request.to,"bob");
  await assert.rejects(f.service.acceptChat({userId:"carol"},request.id),denied("FORBIDDEN"));
});

test("수신자는 결제 없이 수락하고, 동시 수락은 채팅방 하나를 만든다", async () => {
  const f=fixture(), id=await f.paid(), request=await f.service.requestChat(alice,id);
  await assert.rejects(f.service.acceptChat(alice,request.id),denied("FORBIDDEN"));
  const rooms=await Promise.all(Array.from({length:5},()=>f.service.acceptChat(bob,request.id)));
  assert.equal(f.state.rooms.length,1);
  assert.equal(new Set(rooms.map(x=>x.conversationId)).size,1);
  const message=await f.service.sendMessage(bob,rooms[0]!.conversationId,"안녕!");
  assert.equal(message.senderId,"bob");
  assert.equal(f.state.orders.length,1);
  assert.deepEqual(await f.service.createOrder(bob,"b-a"),{kind:"chat_available",conversationId:rooms[0]!.conversationId});
});

test("거절한 요청은 반복 클릭해도 새로 생성하지 않는다", async () => {
  const f=fixture(), id=await f.paid(), request=await f.service.requestChat(alice,id);
  await f.service.rejectChat(bob,request.id);
  assert.equal((await f.service.requestChat(alice,id)).status,"rejected");
  assert.equal(f.state.requests.length,1);
  await assert.rejects(f.service.acceptChat(bob,request.id),denied("INVALID_REQUEST"));
});

test("제3자는 채팅 기록을 읽거나 메시지를 보낼 수 없다", async () => {
  const f=fixture(), room=await f.room();
  await assert.rejects(f.service.messages(eve,room),denied("FORBIDDEN"));
  await assert.rejects(f.service.sendMessage(eve,room,"침입"),denied("FORBIDDEN"));
});

test("차단 후에는 요청·전송·기록 조회를 차단한다", async () => {
  const f=fixture(), room=await f.room();
  f.state.blocks.push(["bob","alice"]);
  await assert.rejects(f.service.messages(alice,room),denied("BLOCKED"));
  await assert.rejects(f.service.sendMessage(bob,room,"차단됨"),denied("BLOCKED"));
  await assert.rejects(f.service.requestChat(alice,f.state.orders[0]!.id),denied("BLOCKED"));
});

test("빈 메시지·과도한 길이는 거부하고 재접속 커서 이후 기록을 반환한다", async () => {
  const f=fixture(), room=await f.room();
  for(const value of ["   ","x".repeat(2001)]) await assert.rejects(f.service.sendMessage(alice,room,value),denied("INVALID_REQUEST"));
  const first=await f.service.sendMessage(alice,room," 첫 메시지 ");
  const second=await f.service.sendMessage(bob,room,"답장");
  assert.equal(first.body,"첫 메시지");
  assert.deepEqual(await f.service.messages(alice,room,first.id),[second]);
  await assert.rejects(f.service.messages(alice,room,"other-room-message"),denied("INVALID_REQUEST"));
});
