import {beforeAll,afterAll,beforeEach,describe,it,expect} from "vitest";
import {createTestDb,seedUsers,recommend,uid,type TestDb,type Recommendation} from "../db/harness";
import {createService,ServiceError} from "../../packages/payment-chat/src/service.ts";
import {createHttpApi} from "../../packages/payment-chat/src/http.ts";
import {createSqlProofRepository} from "./c-sql-repository";
import type {CompletedPayment} from "../../packages/payment-chat/src/ports.ts";

const ME=uid(1),A=uid(10),B=uid(11),C=uid(12),STRANGER=uid(99);
let t:TestDb, recs:Recommendation[], sequence=1000;
let service:ReturnType<typeof createService>;
const gateway={productId:"chat-one",checkoutUrl:(ref:string)=>`https://checkout.example/?ref=${ref}`,
  verifyCompleted:async(raw:Uint8Array,headers:Headers):Promise<CompletedPayment>=>{
    if(headers.get("x-test-signature")!=="valid")throw new ServiceError("INVALID_WEBHOOK","테스트 서명 오류");
    return JSON.parse(new TextDecoder().decode(raw));
  },
};
function makeService(options:{failAfterPayment?:boolean}={}) {
  return createService({repository:createSqlProofRepository(t,options),gateway,id:()=>uid(++sequence),now:()=>new Date().toISOString()});
}
async function event(orderId:string,override:Partial<CompletedPayment>={}) {
  const row=(await t.db.query<{reference:string}>(`select reference from public.orders where id=$1`,[orderId])).rows[0]!;
  return {reference:row.reference,transactionId:`pay-${orderId}`,productId:"chat-one",amount:500,currency:"KRW",...override};
}
async function deliver(orderId:string,instance=service,override:Partial<CompletedPayment>={}) {
  return instance.paymentWebhook(new TextEncoder().encode(JSON.stringify(await event(orderId,override))),new Headers({"x-test-signature":"valid"}));
}
async function create(target=A) {
  const rec=recs.find(x=>x.target_id===target)!;
  const result=await service.createOrder({userId:ME},rec.id);
  expect(result.kind).toBe("payment_required");
  if(result.kind!=="payment_required")throw new Error("주문 생성 실패");
  return result.orderId;
}
async function paid(target=A) {const orderId=await create(target);await deliver(orderId);return orderId;}
async function room(target=A) {
  const orderId=await paid(target);
  const request=await service.requestChat({userId:ME},orderId);
  return (await service.acceptChat({userId:target},request.id)).conversationId;
}
async function counts(){return (await t.db.query<{orders:number;payments:number;matches:number}>(`select
  (select count(*)::int from public.orders) orders,(select count(*)::int from public.payments) payments,
  (select count(*)::int from public.match_results) matches`)).rows[0]!;}

beforeAll(async()=>{t=await createTestDb();});
afterAll(async()=>{await t.db.close();});
beforeEach(async()=>{
  await t.db.exec(`truncate public.messages,public.conversations,public.chat_requests,public.payments,public.orders,public.match_results,public.profiles,auth.users cascade`);
  sequence=1000;
  await seedUsers(t.db,[{id:ME,score:3500},{id:A,score:-3490},{id:B,score:-3530},{id:C,score:-3600},{id:STRANGER,score:9999}]);
  recs=await recommend(t,ME);service=makeService();
});

describe("B SQL과 실제 C 서비스의 연결",()=>{
  it("무료 추천의 ID로 선택한 상대 1명에게 500원 주문을 만든다",async()=>{
    const orderId=await create();
    expect(await service.order({userId:ME},orderId)).toMatchObject({status:"pending",targetId:A});
    expect(await counts()).toEqual({orders:1,payments:0,matches:3});
  });
  it("결제 기록과 대화 권한이 같은 DB 트랜잭션에서 확정된다",async()=>{
    const id=await create();await deliver(id);
    expect((await service.order({userId:ME},id)).status).toBe("fulfilled");
    expect(await counts()).toEqual({orders:1,payments:1,matches:3});
  });
  it("결제 기록 직후 예외를 주입하면 실제 SQL 쓰기가 모두 롤백된다",async()=>{
    const id=await create();
    await expect(deliver(id,makeService({failAfterPayment:true}))).rejects.toThrow("INJECTED_AFTER_PAYMENT");
    expect((await service.order({userId:ME},id)).status).toBe("pending");
    expect((await counts()).payments).toBe(0);
  });
  it("웹훅 중복/동시 전달과 프로필 재클릭에도 주문·결제 하나를 유지한다",async()=>{
    const id=await create();
    await Promise.all(Array.from({length:5},()=>deliver(id)));
    expect(await counts()).toEqual({orders:1,payments:1,matches:3});
    expect(await service.createOrder({userId:ME},recs[0]!.id)).toEqual({kind:"chat_available",orderId:id});
  });
  it("결제 한 건은 다른 상대 주문에 재사용할 수 없다",async()=>{
    const first=await paid(),second=await create(B);
    await expect(deliver(second,service,{transactionId:`pay-${first}`})).rejects.toMatchObject({code:"INVALID_REQUEST"});
    expect((await counts()).payments).toBe(1);
    expect((await service.order({userId:ME},second)).status).toBe("pending");
  });
  it("결제 중 비공개 전환은 결제 기록을 보존하고 환불 대기로 남긴다",async()=>{
    const id=await create();
    await t.db.query(`update public.profiles set is_public=false where id=$1`,[A]);
    expect((await deliver(id)).status).toBe("refund_pending");
    expect((await counts()).payments).toBe(1);
    await expect(service.requestChat({userId:ME},id)).rejects.toMatchObject({code:"FORBIDDEN"});
  });
  it("상대는 별도 주문 없이 수락하고 두 참여자만 메시지를 주고받는다",async()=>{
    const id=await paid(),request=await service.requestChat({userId:ME},id);
    const {conversationId}=await service.acceptChat({userId:A},request.id);
    const first=await service.sendMessage({userId:ME},conversationId,"안녕하세요");
    const second=await service.sendMessage({userId:A},conversationId,"반가워요");
    expect((await service.messages({userId:ME},conversationId)).map(m=>m.id).sort()).toEqual([first.id,second.id].sort());
    expect((await counts()).orders).toBe(1);
    await expect(service.messages({userId:STRANGER},conversationId)).rejects.toMatchObject({code:"FORBIDDEN"});
    expect((await t.asUser(STRANGER,q=>q.query(`select * from public.messages`))).rows).toEqual([]);
    expect((await t.asUser(A,q=>q.query(`select * from public.messages`))).rows).toHaveLength(2);
  });
  it("동일 상대의 수락 재시도는 채팅방을 중복 생성하지 않는다",async()=>{
    const id=await paid(),request=await service.requestChat({userId:ME},id);
    const results=await Promise.all(Array.from({length:4},()=>service.acceptChat({userId:A},request.id)));
    expect(new Set(results.map(x=>x.conversationId)).size).toBe(1);
    expect((await t.db.query(`select * from public.conversations`)).rows).toHaveLength(1);
  });
  it("차단 후 C 서버와 B RLS 양쪽에서 방·기록 접근이 거부된다",async()=>{
    const id=await room();await service.sendMessage({userId:ME},id,"첫 인사");
    await t.asUser(A,q=>q.query(`insert into public.blocks(blocker_id,blocked_id) values($1,$2)`,[A,ME]));
    await expect(service.sendMessage({userId:ME},id,"다시 인사")).rejects.toMatchObject({code:"BLOCKED"});
    expect(await service.conversations({userId:ME})).toEqual([]);
    expect((await t.asUser(ME,q=>q.query(`select * from public.messages`))).rows).toEqual([]);
  });
  it("페이지 커서는 다른 방의 메시지를 가져오지 못한다",async()=>{
    const one=await room(A),two=await room(B);
    const message=await service.sendMessage({userId:ME},one,"첫 방");
    await expect(service.messages({userId:ME},two,message.id)).rejects.toMatchObject({code:"INVALID_REQUEST"});
  });
  it("같은 시각의 메시지는 삽입 순서가 아닌 UUID 순서로 안정 정렬한다",async()=>{
    const id=await room();
    for(const [messageId,body] of [[uid(9002),"먼저 삽입"],[uid(9001),"나중 삽입"]])
      await t.db.query(`insert into public.messages(id,conversation_id,sender_id,body,created_at) values($1,$2,$3,$4,'2026-11-17T00:00:00Z')`,[messageId,id,ME,body]);
    expect((await service.messages({userId:ME},id)).map(m=>m.body)).toEqual(["나중 삽입","먼저 삽입"]);
  });
  it("HTTP 주문·웹훅·요청·수락을 거쳐 B DB에 실제 방을 저장한다",async()=>{
    const origin="https://saju.test";
    const api=createHttpApi({service,appOrigin:origin,getCurrentUserId:async req=>req.headers.get("x-test-user")});
    const send=(path:string,user:string|null,body:unknown,extra:Record<string,string>={})=>api(new Request(origin+path,{method:"POST",headers:{origin,"content-type":"application/json",...(user?{"x-test-user":user}:{}),...extra},body:JSON.stringify(body)}));
    const orderResponse=await send("/api/orders",ME,{matchResultId:recs[0]!.id});
    expect(orderResponse.status).toBe(200);const {orderId}=await orderResponse.json();
    const payment=await send("/api/webhooks/groble",null,await event(orderId),{"x-test-signature":"valid"});
    expect(payment.status).toBe(200);
    const request=await (await send("/api/chat-requests",ME,{orderId})).json();
    const accepted=await send(`/api/chat-requests/${request.id}/accept`,A,{});
    expect(accepted.status).toBe(200);
    expect((await t.db.query(`select * from public.conversations`)).rows).toHaveLength(1);
  });
  it("상대 점수 비공개 계약은 직접 DB 조회에서도 유지되어야 한다",async()=>{
    await expect(t.asUser(ME,q=>q.query(`select target_score,distance from public.match_results`))).rejects.toThrow(/permission denied/);
  });
});
