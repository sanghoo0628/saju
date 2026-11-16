import test from "node:test";
import assert from "node:assert/strict";
import { createHttpApi } from "../src/http.ts";
import { fixture } from "./fixtures.ts";
import { ServiceError } from "../src/service.ts";

const origin = "https://saju.example";
function setup() {
  const f = fixture();
  const handle = createHttpApi({ service:f.service, appOrigin:origin,
    // 테스트 전용 세션 조회. 운영에서는 A의 getCurrentUserId()를 연결한다.
    getCurrentUserId:async req => req.headers.get("x-test-session"),
  });
  const request = (path: string, opts: { user?: string; method?: string; body?: unknown; headers?: Record<string,string> } = {}) =>
    handle(new Request(origin+path, { method:opts.method ?? "GET", headers:{
      ...(opts.user ? {"x-test-session":opts.user} : {}),
      ...(opts.body !== undefined ? {"content-type":"application/json"} : {}),
      origin,...opts.headers,
    }, ...(opts.body !== undefined ? {body:JSON.stringify(opts.body)} : {}) }));
  return { f, handle, request };
}

test("HTTP로 주문→결제 웹훅→대화 요청→무료 수락→메시지 왕복을 연결한다", async () => {
  const { f, request } = setup();
  const orderResponse = await request("/api/orders",{method:"POST",user:"alice",body:{matchResultId:"a-b"}});
  assert.equal(orderResponse.status,200);
  const order = await orderResponse.json();
  assert.equal(order.amountKrw,500);
  assert.equal(order.kind,"payment_required");
  const unpaid = await request("/api/chat-requests",{method:"POST",user:"alice",body:{orderId:order.orderId}});
  assert.equal(unpaid.status,403);
  const paid = await request("/api/webhooks/groble",{method:"POST",body:f.event(order.orderId),headers:{"x-test-verified":"yes"}});
  assert.equal(paid.status,200); // 웹훅은 사용자 세션이 없다.
  assert.equal((await paid.json()).status,"fulfilled");
  const status = await request(`/api/orders/${order.orderId}`,{user:"alice"});
  assert.equal((await status.json()).targetId,"bob");
  const invitation = await (await request("/api/chat-requests",{method:"POST",user:"alice",body:{orderId:order.orderId}})).json();
  const accepted = await request(`/api/chat-requests/${invitation.id}/accept`,{method:"POST",user:"bob"});
  assert.equal(accepted.status,200);
  const { conversationId } = await accepted.json();
  const sent = await request(`/api/conversations/${conversationId}/messages`,{method:"POST",user:"bob",body:{body:"안녕!"}});
  assert.equal(sent.status,200);
  const message = await sent.json();
  assert.equal(message.senderId,"bob");
  const history = await request(`/api/conversations/${conversationId}/messages`,{user:"alice"});
  assert.deepEqual(await history.json(),[message]);
  assert.equal(f.state.orders.length,1);
  const cursor = await request(`/api/conversations/${conversationId}/messages?afterId=${message.id}`,{user:"alice"});
  assert.deepEqual(await cursor.json(),[]);
});

test("로그인 없는 브라우저 요청은 401이며 주문이 만들어지지 않는다", async () => {
  const { f, request }=setup();
  const res=await request("/api/orders",{method:"POST",body:{matchResultId:"a-b"}});
  assert.equal(res.status,401);
  assert.equal((await res.json()).code,"UNAUTHENTICATED");
  assert.equal(f.state.orders.length,0);
});

test("클라이언트 buyer_id·가격·다른 사용자 필드를 허용하지 않는다", async () => {
  const { f, request }=setup();
  for(const extra of [{buyer_id:"bob"},{amountKrw:1},{userId:"bob"},{status:"fulfilled"}]) {
    const res=await request("/api/orders",{method:"POST",user:"alice",body:{matchResultId:"a-b",...extra}});
    assert.equal(res.status,400);
  }
  assert.equal(f.state.orders.length,0);
});

test("다른 출처·누락·유사 출처의 쿠키 기반 POST를 거부한다", async () => {
  const { f, request, handle }=setup();
  for(const value of ["https://evil.example",`${origin}.evil.example`,"null"]) {
    assert.equal((await request("/api/orders",{method:"POST",user:"alice",body:{matchResultId:"a-b"},headers:{origin:value}})).status,403);
  }
  const missing=new Request(`${origin}/api/orders`,{method:"POST",headers:{"x-test-session":"alice","content-type":"application/json"},body:'{"matchResultId":"a-b"}'});
  assert.equal((await handle(missing)).status,403);
  assert.equal(f.state.orders.length,0);
});

test("잘못된 JSON·필드·식별자·Content-Type을 거부한다", async () => {
  const { request, handle }=setup();
  for(const body of [null,[],{}, {matchResultId:123}, {matchResultId:"../evil"}])
    assert.equal((await request("/api/orders",{method:"POST",user:"alice",body})).status,400);
  const headers={origin,"x-test-session":"alice","content-type":"application/json"};
  assert.equal((await handle(new Request(`${origin}/api/orders`,{method:"POST",headers,body:'{"oops"'}))).status,400);
  assert.equal((await request("/api/orders",{method:"POST",user:"alice",body:{matchResultId:"a-b"},headers:{"content-type":"text/plain"}})).status,415);
});

test("본문 길이를 헤더와 실제 바이트 모두에서 제한한다", async () => {
  const { request, handle }=setup();
  assert.equal((await request("/api/orders",{method:"POST",user:"alice",body:{matchResultId:"a-b"},headers:{"content-length":"999999"}})).status,413);
  const headers={origin,"x-test-session":"alice","content-type":"application/json","content-length":"1"};
  assert.equal((await handle(new Request(`${origin}/api/orders`,{method:"POST",headers,body:' '.repeat(17000)}))).status,413);
});

test("청크 전송도 실제 누적 크기로 제한한다", async () => {
  const { handle }=setup();
  const stream=new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(9000)); controller.enqueue(new Uint8Array(9000)); controller.close();
  } });
  const init={method:"POST",headers:{origin,"x-test-session":"alice","content-type":"application/json"},body:stream,duplex:"half"};
  assert.equal((await handle(new Request(`${origin}/api/orders`,init as RequestInit))).status,413);
});

test("없는 API와 잘못된 HTTP 메서드는 404·405와 Allow를 반환한다", async () => {
  const { request }=setup();
  assert.equal((await request("/api/missing")).status,404);
  const res=await request("/api/orders");
  assert.equal(res.status,405);
  assert.equal(res.headers.get("allow"),"POST");
  assert.equal((await request("/api/webhooks/groble")).status,405);
});

test("HTTP에서도 제3자의 주문·채팅 조회와 작성자 위조를 거부한다", async () => {
  const { f, request }=setup();
  const room=await f.room(), orderId=f.state.orders[0].id;
  assert.equal((await request(`/api/orders/${orderId}`,{user:"eve"})).status,403);
  assert.equal((await request(`/api/conversations/${room}/messages`,{user:"eve"})).status,403);
  assert.equal((await request(`/api/conversations/${room}/messages`,{method:"POST",user:"alice",body:{body:"hi",senderId:"bob"}})).status,400);
});

test("수락·거절 요청도 알 수 없는 본문 필드를 거부한다", async () => {
  const { f, request }=setup();
  const orderId=await f.paid(), invitation=await f.service.requestChat({userId:"alice"},orderId);
  assert.equal((await request(`/api/chat-requests/${invitation.id}/accept`,{method:"POST",user:"bob",body:{recipient_id:"alice"}})).status,400);
  const rejected=await request(`/api/chat-requests/${invitation.id}/reject`,{method:"POST",user:"bob",body:{}});
  assert.equal(rejected.status,200);
  assert.equal((await rejected.json()).status,"rejected");
});

test("메시지 커서 중복·미지원 조건을 거부한다", async () => {
  const { f, request }=setup(), room=await f.room();
  for(const query of ["afterId=a&afterId=b","afterId=","senderId=bob"])
    assert.equal((await request(`/api/conversations/${room}/messages?${query}`,{user:"alice"})).status,400);
});

test("받은 요청과 대화 목록은 본인에게만 보이고 차단 시 사라진다", async () => {
  const { f, request }=setup();
  const orderId=await f.paid();
  const invitation=await f.service.requestChat({userId:"alice"},orderId);
  assert.deepEqual(await (await request("/api/chat-requests",{user:"bob"})).json(),[invitation]);
  assert.deepEqual(await (await request("/api/chat-requests",{user:"eve"})).json(),[]);
  assert.equal((await request(`/api/chat-requests?afterId=${invitation.id}`,{user:"eve"})).status,400);
  const {conversationId}=await f.service.acceptChat({userId:"bob"},invitation.id);
  const rooms=await (await request("/api/conversations",{user:"bob"})).json();
  assert.equal(rooms[0].id,conversationId);
  assert.deepEqual(await (await request("/api/conversations",{user:"eve"})).json(),[]);
  assert.equal((await request(`/api/conversations?afterId=${conversationId}`,{user:"eve"})).status,400);
  f.state.blocks.push(["alice","bob"]);
  assert.deepEqual(await (await request("/api/chat-requests",{user:"bob"})).json(),[]);
  assert.deepEqual(await (await request("/api/conversations",{user:"bob"})).json(),[]);
});

test("요청 목록은 최신순이며 같은 시각에도 커서로 다음 페이지를 조회한다", async () => {
  const { f, request }=setup();
  const firstId=await f.paid("a-b");
  const first=await f.service.requestChat({userId:"alice"},firstId);
  const secondId=await f.paid("a-c");
  const second=await f.service.requestChat({userId:"alice"},secondId);
  assert.deepEqual(await (await request("/api/chat-requests",{user:"alice"})).json(),[second,first]);
  assert.deepEqual(await (await request(`/api/chat-requests?afterId=${second.id}`,{user:"alice"})).json(),[first]);
});

test("웹훅은 JSON 재직렬화 없이 바이트와 헤더를 검증기로 전달한다", async () => {
  const f=fixture();
  const raw=' {\n  "signature_input" : "원문 + 공백"\n}\n';
  let authenticated=false;
  const service={...f.service,paymentWebhook:async (bytes:Uint8Array,headers:Headers)=>{
    assert.deepEqual(bytes,new TextEncoder().encode(raw));
    assert.equal(headers.get("x-provider-signature"),"provider-proof");
    return {status:"fulfilled"};
  }};
  const api=createHttpApi({service:service as typeof f.service, appOrigin:origin,getCurrentUserId:async()=>{authenticated=true;return null;}});
  const res=await api(new Request(`${origin}/api/webhooks/groble`,{method:"POST",headers:{"x-provider-signature":"provider-proof"},body:raw}));
  assert.equal(res.status,200);
  assert.equal(authenticated,false);
});

test("잘못된 웹훅 서명은 400이며 권한을 생성하지 않는다", async () => {
  const { f, request }=setup();
  const order=await f.service.createOrder({userId:"alice"},"a-b");
  if(order.kind!=="payment_required") throw new Error();
  const res=await request("/api/webhooks/groble",{method:"POST",body:f.event(order.orderId)});
  assert.equal(res.status,400);
  assert.equal((await res.json()).code,"INVALID_WEBHOOK");
  assert.equal(f.state.payments.length,0);
});

test("응답은 캐시하지 않고 서버 예외 원문은 노출하지 않는다", async () => {
  const f=fixture();
  const handle=createHttpApi({service:f.service,appOrigin:origin,getCurrentUserId:async()=>{throw new Error("sb_secret_NEVER_EXPOSE");}});
  const response=await handle(new Request(`${origin}/api/orders/id-1`));
  assert.equal(response.status,500);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.doesNotMatch(await response.text(),/sb_secret|NEVER_EXPOSE/);
});

test("일시적인 제공자 오류는 재시도 가능한 503으로 구분한다", async () => {
  const f=fixture();
  const api=createHttpApi({service:{...f.service,paymentWebhook:async()=>{throw new ServiceError("PROVIDER_UNAVAILABLE","결제 확인 서버에 연결할 수 없습니다.");}},appOrigin:origin,getCurrentUserId:async()=>null});
  assert.equal((await api(new Request(`${origin}/api/webhooks/groble`,{method:"POST",body:"raw"}))).status,503);
});
