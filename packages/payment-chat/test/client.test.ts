import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient, PaymentChatClientError } from "../src/client.ts";
import { createHttpApi } from "../src/http.ts";
import { fixture } from "./fixtures.ts";

test("브라우저 클라이언트에서 실제 HTTP 어댑터와 핵심 로직을 왕복한다", async () => {
  const f=fixture(), origin="https://saju.example";
  const api=createHttpApi({service:f.service,appOrigin:origin,getCurrentUserId:async req=>req.headers.get("x-test-session")});
  const browser=(userId:string)=>createBrowserClient(async (url,init)=>{
    assert.equal(init?.credentials,"same-origin");
    return api(new Request(origin+url,{...init,headers:{...init?.headers,origin,"x-test-session":userId}}));
  });
  const alice=browser("alice"), bob=browser("bob");
  const order=await alice.createOrder("a-b");
  assert.equal(order.kind,"payment_required");
  if(order.kind!=="payment_required") throw new Error();
  await f.deliver(f.event(order.orderId));
  assert.equal((await alice.order(order.orderId)).status,"fulfilled");
  const invitation=await alice.requestChat(order.orderId);
  assert.deepEqual(await bob.requests(),[invitation]);
  const {conversationId}=await bob.acceptChat(invitation.id);
  assert.equal((await alice.conversations())[0]!.id,conversationId);
  const message=await bob.sendMessage(conversationId,"반가워!");
  assert.deepEqual(await alice.messages(conversationId),[message]);
  assert.deepEqual(await alice.messages(conversationId,message.id),[]);
  assert.equal((await alice.createOrder("a-b")).kind,"chat_available");
});

test("서버의 권한 오류를 코드와 상태를 보존한 클라이언트 오류로 전달한다", async () => {
  const client=createBrowserClient(async()=>Response.json({code:"FORBIDDEN",message:"접근할 수 없습니다."},{status:403}));
  await assert.rejects(client.requestChat("some-order"),(error:unknown)=>error instanceof PaymentChatClientError && error.code==="FORBIDDEN" && error.status===403);
});

test("JSON이 아닌 오류 응답도 예측 가능한 오류로 처리한다", async () => {
  const client=createBrowserClient(async()=>new Response("Bad gateway",{status:502}));
  await assert.rejects(client.conversations(),(error:unknown)=>error instanceof PaymentChatClientError && error.code==="INVALID_RESPONSE" && error.status===502);
});

test("이미 취소된 화면의 요청은 fetch를 호출하지 않는다", async () => {
  const controller=new AbortController(); controller.abort();
  const client=createBrowserClient(async ()=>{
    throw new Error("unreachable");
  });
  await assert.rejects(client.requests(undefined,controller.signal),{name:"AbortError"});
});
