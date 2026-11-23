import test from "node:test";
import assert from "node:assert/strict";
import { createCheckoutFlow } from "../src/checkout-flow.ts";
import { PaymentChatClientError } from "../src/client.ts";
import type { createBrowserClient } from "../src/client.ts";
import type { CreateOrderResponse, OrderResponse } from "../../../contracts/payment-chat.ts";

type Client = Pick<ReturnType<typeof createBrowserClient>,"createOrder"|"order">;
const checkout:CreateOrderResponse={kind:"payment_required",orderId:"order-1",amountKrw:500,checkoutUrl:"https://groble.example/checkout"};
const order=(status:OrderResponse["status"]):OrderResponse=>({orderId:"order-1",targetId:"bob",status});
const client=(overrides:Partial<Client>={}):Client=>({createOrder:async()=>checkout,order:async()=>order("pending"),...overrides});
const instant=async()=>{};
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}

test("구매 버튼 중복 클릭은 주문 호출 하나로 합친다",async()=>{
  let calls=0;
  const response=deferred<CreateOrderResponse>();
  const flow=createCheckoutFlow({client:client({createOrder:async()=>{calls++;return response.promise;}})});
  const first=flow.start("match-1"), second=flow.start("match-1");
  assert.equal(first,second);
  await Promise.resolve();
  assert.equal(flow.snapshot().kind,"creating");
  response.resolve(checkout);
  await first;
  assert.equal(calls,1);
  assert.deepEqual(flow.snapshot(),checkout);
});

test("이미 대화 가능한 상대는 결제 화면 없이 기존 대화로 연결한다",async()=>{
  const flow=createCheckoutFlow({client:client({createOrder:async()=>({kind:"chat_available",conversationId:"room-1"})})});
  await flow.start("match-1");
  assert.deepEqual(flow.snapshot(),{kind:"chat_available",conversationId:"room-1"});
});

test("결제 복귀는 pending을 기다린 후 서버 fulfilled에서만 대화 가능해진다",async()=>{
  let polls=0,creates=0;
  const flow=createCheckoutFlow({client:client({createOrder:async()=>{creates++;return checkout;},order:async()=>order(++polls<3?"pending":"fulfilled")}),delay:instant});
  await flow.resume("order-1");
  assert.equal(polls,3);
  assert.equal(creates,0);
  assert.deepEqual(flow.snapshot(),{kind:"chat_available",orderId:"order-1"});
});

test("확인이 늦으면 주문 ID를 유지하며 재결제를 요구하지 않는다",async()=>{
  let polls=0;
  const flow=createCheckoutFlow({client:client({order:async()=>{polls++;return order("pending");}}),maxAttempts:3,delay:instant});
  await flow.resume("order-1");
  assert.equal(polls,3);
  assert.deepEqual(flow.snapshot(),{kind:"confirmation_pending",orderId:"order-1"});
});

test("환불 대기·환불 완료·취소는 성공으로 취급하지 않는다",async()=>{
  for(const status of ["refund_pending","refunded","cancelled"] as const) {
    const flow=createCheckoutFlow({client:client({order:async()=>order(status)})});
    await flow.resume("order-1");
    assert.deepEqual(flow.snapshot(),{kind:status,orderId:"order-1"});
  }
});

test("일시적인 GET 실패만 재시도하고 성공하면 기존 주문을 복구한다",async()=>{
  let polls=0;
  const flow=createCheckoutFlow({client:client({order:async()=>{
    if(++polls===1) throw new PaymentChatClientError("PROVIDER_UNAVAILABLE","잠시 후 다시 시도",503);
    return order("fulfilled");
  }}),delay:instant});
  await flow.resume("order-1");
  assert.equal(polls,2);
  assert.equal(flow.snapshot().kind,"chat_available");
});

test("로그인·권한 오류는 반복 조회하지 않고 주문 ID를 보존한다",async()=>{
  let polls=0;
  const flow=createCheckoutFlow({client:client({order:async()=>{polls++;throw new PaymentChatClientError("UNAUTHENTICATED","다시 로그인해주세요.",401);}}),delay:instant});
  await flow.resume("order-1");
  assert.equal(polls,1);
  assert.deepEqual(flow.snapshot(),{kind:"error",orderId:"order-1",message:"다시 로그인해주세요."});
});

test("다른 프로필 선택 후 늦게 도착한 이전 응답은 화면을 바꾸지 않는다",async()=>{
  const old=deferred<CreateOrderResponse>();
  const flow=createCheckoutFlow({client:client({createOrder:async id=>id==="old"?old.promise:{kind:"chat_available",conversationId:"new-room"}})});
  const pending=flow.start("old"); await Promise.resolve();
  await flow.start("new");
  old.resolve(checkout); await pending;
  assert.deepEqual(flow.snapshot(),{kind:"chat_available",conversationId:"new-room"});
});

test("화면을 바로 닫으면 아직 시작하지 않은 주문 요청도 실행하지 않는다",async()=>{
  let calls=0;
  const flow=createCheckoutFlow({client:client({createOrder:async()=>{calls++;return checkout;}})});
  const pending=flow.start("match-1"); flow.reset(); await pending;
  assert.equal(calls,0);
  assert.deepEqual(flow.snapshot(),{kind:"idle"});
});

test("계정 변경 시 남은 응답이 해제된 화면에 반영되지 않는다",async()=>{
  const response=deferred<OrderResponse>();
  const flow=createCheckoutFlow({client:client({order:async()=>response.promise})});
  const pending=flow.resume("order-1"); await Promise.resolve();
  flow.dispose(); response.resolve(order("fulfilled")); await pending;
  assert.deepEqual(flow.snapshot(),{kind:"idle"});
  assert.throws(()=>flow.start("match-1"),/해제/);
});

test("확인 시간 초과는 결제 실패나 성공으로 단정하지 않는다",async()=>{
  const flow=createCheckoutFlow({client:client({order:async(_id,signal)=>new Promise((_resolve,reject)=>{
    signal!.addEventListener("abort",()=>reject(signal!.reason),{once:true});
  })}),timeoutMs:20});
  await flow.resume("order-1");
  assert.deepEqual(flow.snapshot(),{kind:"confirmation_pending",orderId:"order-1"});
});

test("결제 주소가 HTTPS가 아니면 이동 가능한 상태를 만들지 않는다",async()=>{
  const flow=createCheckoutFlow({client:client({createOrder:async()=>({...checkout,kind:"payment_required",orderId:"order-1",amountKrw:500,checkoutUrl:"javascript:alert(1)"})})});
  await flow.start("match-1");
  assert.equal(flow.snapshot().kind,"error");
});

test("화면 구독 콜백 오류가 결제 성공 처리를 방해하지 않는다",async()=>{
  let errors=0;
  const flow=createCheckoutFlow({client:client({order:async()=>order("fulfilled")}),onObserverError:()=>{errors++;}});
  flow.subscribe(()=>{throw new Error("render error");});
  await flow.resume("order-1");
  assert.equal(flow.snapshot().kind,"chat_available");
  assert.equal(errors,2);
});

test("다른 주문의 응답은 대화 권한으로 사용하지 않는다",async()=>{
  const flow=createCheckoutFlow({client:client({order:async()=>({...order("fulfilled"),orderId:"other"})}),maxAttempts:1});
  await flow.resume("order-1");
  assert.equal(flow.snapshot().kind,"confirmation_pending");
});

test('환불 재확인 연결 오류는 마지막 환불 대기를 유지하고 복구 후 완료 상태를 반영한다', async () => {
  let mode: 'refund_pending' | 'offline' | 'refunded' = 'refund_pending';
  let creates = 0;
  const flow = createCheckoutFlow({ client: client({
    createOrder: async () => { creates++; return checkout; },
    order: async () => {
      if (mode === 'offline') throw new TypeError('offline');
      return order(mode);
    },
  }), maxAttempts: 2, delay: instant });
  await flow.resume('order-1');
  mode = 'offline';
  await flow.resume('order-1');
  const failed = flow.snapshot();
  assert.equal(failed.kind, 'refund_pending');
  if (failed.kind !== 'refund_pending') throw new Error('refund state missing');
  assert.equal(failed.orderId, 'order-1');
  assert.match(failed.refreshError ?? '', /마지막으로 확인한 상태는 환불 대기/);
  mode = 'refunded';
  await flow.resume('order-1');
  assert.deepEqual(flow.snapshot(), { kind: 'refunded', orderId: 'order-1' });
  assert.equal(creates, 0);
});

test('환불 재확인 시간 초과도 환불 대기와 같은 주문을 유지한다', async () => {
  let stall = false;
  const flow = createCheckoutFlow({ client: client({ order: async (_id, signal) => {
    if (!stall) return order('refund_pending');
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  } }), timeoutMs: 20 });
  await flow.resume('order-1');
  stall = true;
  await flow.resume('order-1');
  const state = flow.snapshot();
  assert.equal(state.kind, 'refund_pending');
  if (state.kind !== 'refund_pending') throw new Error('refund state missing');
  assert.match(state.refreshError ?? '', /확인하지 못했어요/);
});

test('다른 주문 재확인과 인증 실패에는 이전 환불 상태를 재사용하지 않는다', async () => {
  let mode: 'refund_pending' | 'offline' | 'unauthorized' = 'refund_pending';
  const flow = createCheckoutFlow({ client: client({ order: async () => {
    if (mode === 'offline') throw new TypeError('offline');
    if (mode === 'unauthorized') throw new PaymentChatClientError('UNAUTHENTICATED', '다시 로그인해주세요.', 401);
    return order('refund_pending');
  } }), maxAttempts: 1 });
  await flow.resume('order-1');
  mode = 'unauthorized';
  await flow.resume('order-1');
  assert.equal(flow.snapshot().kind, 'error');
  mode = 'refund_pending';
  await flow.resume('order-1');
  mode = 'offline';
  await flow.resume('other-order');
  assert.deepEqual(flow.snapshot(), { kind: 'confirmation_pending', orderId: 'other-order' });
});

test('서버가 새 pending 상태를 확인해 주면 이전 환불 상태보다 새 응답을 우선한다', async () => {
  let status: OrderResponse['status'] = 'refund_pending';
  const flow = createCheckoutFlow({ client: client({ order: async () => order(status) }), maxAttempts: 1 });
  await flow.resume('order-1');
  status = 'pending';
  await flow.resume('order-1');
  assert.deepEqual(flow.snapshot(), { kind: 'confirmation_pending', orderId: 'order-1' });
});
