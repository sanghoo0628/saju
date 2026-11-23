/** Explicit, disposable live QA. Never run in CI or against an arbitrary project. */
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createBrowserClient } from '../packages/payment-chat/src/client';
import { createSupabaseMessageSource } from '../packages/payment-chat/src/supabase-message-source';
import { createMessageSession } from '../packages/payment-chat/src/message-session';
import type { ChatMessage } from '../contracts/payment-chat';

const project = 'acghfykdtorpxkbmknja';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const pub = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
const base = process.env.C_LIVE_QA_APP_URL;
if (process.env.C_LIVE_QA_PROJECT_REF !== project || url !== `https://${project}.supabase.co` || !pub || !secret || !base)
  throw new Error('Explicit development project and local QA app URL are required');
function safeUrl(value: string) { try { return new URL(value); } catch { throw new Error('Valid QA URL configuration is required'); } }
const app = safeUrl(base);
if (app.protocol !== 'http:' || app.hostname !== '127.0.0.1' || app.pathname !== '/' || app.search || app.hash || app.username || app.password)
  throw new Error('QA app must use an explicit loopback HTTP origin');
const databaseTarget = safeUrl(process.env.DATABASE_URL ?? '');
if (databaseTarget.username !== `postgres.${project}` && databaseTarget.hostname !== `db.${project}.supabase.co`) throw new Error('DB connection must target the designated development project');
class QaFailure extends Error {}
const cancelled = new AbortController();
process.once('SIGINT', () => cancelled.abort());
process.once('SIGTERM', () => cancelled.abort());
const runId = randomUUID();
const prefix = `c-live-qa:${runId}`;
const root = new URL('../', import.meta.url);
const manifestPath = new URL(`.env.c-live-qa-${runId}.json`, root);
const reportPath = new URL(`../outputs/C_Supabase_QA_${runId.slice(0, 8)}.json`, root);
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const users: { id: string; email: string; jar: Map<string,string> }[] = [];
const stops: (() => void)[] = [];
const clients: (typeof admin)[] = [];
const checks: string[] = [];
const orderId = randomUUID(), matchId = randomUUID();
let roomId: string | undefined, currentCheck = 'initializing', successful = false, cleaned = false;
let pool: Pool | undefined;
const assert = (ok: unknown, label: string) => { if (!ok) throw new QaFailure(label); };
async function savedManifest() {
  await writeFile(manifestPath, JSON.stringify({ project, runId, userIds: users.map(u => u.id), orderId, matchId, roomId }), { mode: 0o600 });
}
async function step(label: string, operation: () => Promise<void>) {
  currentCheck = label; cancelled.signal.throwIfAborted(); await operation(); checks.push(label); console.log(JSON.stringify({ check: label, passed: true }));
}
async function until(condition: () => boolean, label: string, ms = 15000) {
  const end = Date.now() + ms;
  while (!condition()) { cancelled.signal.throwIfAborted(); if (Date.now() > end) throw new QaFailure(label); await delay(100); }
}
async function http(user: typeof users[number] | undefined, path: string, init: RequestInit = {}) {
  const target = new URL(path, app);
  assert(target.origin === app.origin, 'Cross-origin QA request refused');
  const headers = new Headers(init.headers);headers.set('origin', app.origin);
  if (user) headers.set('cookie', [...user.jar].map(([k,v]) => `${k}=${v}`).join('; '));
  const response = await fetch(target, { ...init, headers, redirect: 'error', signal: AbortSignal.any([cancelled.signal, init.signal ?? AbortSignal.timeout(20000)]) });
  if (user) for (const c of response.headers.getSetCookie()) {
    const first = c.split(';',1)[0]!; const n = first.indexOf('=');
    const k = first.slice(0,n), v = first.slice(n+1);
    if (!v) user.jar.delete(k); else user.jar.set(k,v);
  }
  return response;
}
const apiFor = (user: typeof users[number]) => createBrowserClient(((path, init) => http(user, String(path), init)) as typeof fetch);
async function sql(text: string, values: unknown[] = []) { return pool!.query(text, values); }
async function cleanup() {
  for (const stop of stops) { try { stop(); } catch { /* Finish all cleanup. */ } }
  await Promise.race([Promise.allSettled(clients.map(c => c.removeAllChannels())), delay(3000)]);
  if (pool) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (roomId) { await c.query('delete from public.messages where conversation_id=$1',[roomId]); }
      await c.query('delete from public.chat_requests where order_id=$1',[orderId]);
      if (roomId) await c.query('delete from public.conversations where id=$1',[roomId]);
      if (users.length >= 2) await c.query('delete from public.blocks where blocker_id=$1 and blocked_id=$2',[users[1]!.id,users[0]!.id]);
      await c.query('delete from public.orders where id=$1 and reference=$2',[orderId,prefix]);
      await c.query('delete from public.match_results where id=$1 and user_id=any($2::uuid[])',[matchId,users.map(u=>u.id)]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  for (const u of users) {
    const found = await admin.auth.admin.getUserById(u.id);
    if (found.error?.status === 404) continue;
    if (found.error) throw new Error('QA cleanup ownership lookup failed');
    assert(found.data.user.app_metadata.c_qa_run === runId, 'QA cleanup ownership mismatch');
    const removed = await admin.auth.admin.deleteUser(u.id);
    assert(!removed.error, 'QA account cleanup failed');
  }
  if (pool && users.length) {
    const result = await sql('select count(*)::int n from auth.users where id=any($1::uuid[])',[users.map(u=>u.id)]);
    assert(result.rows[0].n===0, 'QA users remain after cleanup');
  }
  if (pool) {
    const leftovers = await sql(`select
      (select count(*)::int from public.orders where id=$1) as orders,
      (select count(*)::int from public.match_results where id=$2) as matches,
      (select count(*)::int from public.chat_requests where order_id=$1) as requests,
      (select count(*)::int from public.conversations where id=$3) as rooms,
      (select count(*)::int from public.messages where conversation_id=$3) as messages`, [orderId,matchId,roomId??null]);
    assert(Object.values(leftovers.rows[0]).every(value=>value===0),'QA records remain after cleanup');
  }
  cleaned = true; await unlink(manifestPath).catch(()=>{});
}

async function main() {
  try {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: true, ca: await readFile(process.env.DATABASE_SSL_CA_PATH!, 'utf8') } });
    await savedManifest();
    const ready = await http(undefined, '/api/me');
    assert(ready.status === 401, `Configured QA server readiness status ${ready.status}`);
    await step('Create three disposable Auth users without sending email', async () => {
      for (let i=0;i<3;i++) {
        const email=`c-qa-${runId.slice(0,12)}-${i}@qa.example.invalid`;
        const created=await admin.auth.admin.createUser({email,email_confirm:true,app_metadata:{c_qa_run:runId}});
        assert(!created.error && created.data.user, 'QA user creation failed');
        users.push({id:created.data.user!.id,email,jar:new Map()}); await savedManifest();
      }
    });
    await step('Verify A OTP endpoint and real Auth identity for all users', async () => {
      for (const user of users) {
        const generated=await admin.auth.admin.generateLink({type:'magiclink',email:user.email});
        assert(!generated.error && generated.data.properties, 'QA OTP generation failed');
        const token=generated.data.properties!.email_otp;
        assert(/^\d{6,10}$/.test(token), 'Project OTP is outside the supported numeric format');
        const result=await http(user,'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:user.email,token})});
        assert(result.status===200, `A OTP verification status ${result.status}`);
        if (user === users[0]) {
          const replay=await http(user,'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:user.email,token})});
          assert(replay.status===400,'A used OTP was accepted again');
        }
        const me=await http(user,'/api/me'); const identity=await me.json();
        assert(me.status===200 && identity.userId===user.id && identity.schoolVerification?.status==='verified', 'A verified identity mismatch');
        const ssr=createServerClient(url!,pub!,{cookies:{getAll:()=>[...user.jar].map(([name,value])=>({name,value:decodeURIComponent(value)})),setAll:()=>{}}});
        const session=await ssr.auth.getSession();assert(session.data.session,'SSR cookie session missing');
        const realtime=createClient(url!,pub!,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
        const signed=await realtime.auth.setSession(session.data.session!);assert(!signed.error,'Realtime session setup failed');clients.push(realtime);
      }
    });
    const [buyer,recipient,stranger]=users as [typeof users[number],typeof users[number],typeof users[number]];
    const a=apiFor(buyer),b=apiFor(recipient),c=apiFor(stranger);
    await step('Prepare chat-only fixtures excluded from normal fortune matching', async () => {
      for (let i=0;i<users.length;i++) await sql("insert into public.profiles(id,nickname,track,is_public,bio) values($1,$2,'humanities',true,$3)",[users[i]!.id,`C QA ${i+1}`,'Temporary chat-only QA account']);
      const fortune=await sql('select count(*)::int n from public.fortune_results where user_id=any($1::uuid[])',[users.map(u=>u.id)]);
      assert(fortune.rows[0].n===0,'QA fixtures must not enter the scored recommendation pool');
      await sql('insert into public.match_results(id,user_id,target_id,rank,distance,target_score) values($1,$2,$3,1,0,0)',[matchId,buyer.id,recipient.id]);
      await sql("insert into public.orders(id,buyer_id,target_id,match_result_id,amount,status,reference) values($1,$2,$3,$4,500,'fulfilled',$5)",[orderId,buyer.id,recipient.id,matchId,prefix]);
    });
    await step('Reuse a test entitlement and accept an actual chat request', async () => {
      assert((await a.createOrder(matchId)).kind==='chat_available','Existing entitlement not reused');
      const request=await a.requestChat(orderId);
      assert((await b.requests()).some(r=>r.id===request.id),'Recipient request missing');
      assert((await c.requests()).length===0,'Third user can see a private request');
      let denied=false;try{await c.acceptChat(request.id);}catch(e){denied=(e as {status?:number}).status===403;}assert(denied,'Third-user accept was not denied');
      roomId=(await b.acceptChat(request.id)).conversationId;await savedManifest();
      assert((await b.acceptChat(request.id)).conversationId===roomId,'Accepted room was duplicated');
      assert((await a.conversations()).some(r=>r.id===roomId),'Buyer room missing');
      assert((await c.conversations()).length===0,'Third user can see a private room');
    });
    const received:ChatMessage[][]=[[],[],[]];const live=[false,false,false];
    await step('Subscribe all three real JWT clients through C Realtime source', async () => {
      for(let i=0;i<3;i++) stops.push(createSupabaseMessageSource(clients[i]!).subscribe({userId:users[i]!.id,conversationId:roomId!,
        onStatus:status=>{if(status==='live')live[i]=true;},onMessage:message=>{received[i]!.push(message);}}));
      await until(()=>live.every(Boolean),'Realtime subscription timed out',25000);
    });
    await step('Deliver persisted messages to participants and reject the third user', async () => {
      const message=await a.sendMessage(roomId!,'C QA: first authenticated message');
      await until(()=>received[0]!.some(m=>m.id===message.id)&&received[1]!.some(m=>m.id===message.id),'Participant Realtime delivery timed out');
      assert((await b.messages(roomId!)).some(m=>m.id===message.id),'Stored message missing');
      let denied=false;try{await c.messages(roomId!);}catch(e){denied=(e as {status?:number}).status===403;}assert(denied,'Third-user history was not denied');
      const forbidden=await clients[2]!.from('messages').select('id').eq('conversation_id',roomId!);assert(!forbidden.error&&forbidden.data.length===0,'Third-user RLS leaked messages');
      await delay(1500);assert(received[2]!.length===0,'Third-user Realtime leaked messages');
    });
    await step('Recover persisted history with C message session after reconnect', async () => {
      stops[0]!();
      const message=await b.sendMessage(roomId!,'C QA: message sent while A subscription was stopped');
      await until(()=>received[1]!.some(m=>m.id===message.id),'Sender echo missing');
      const room=(await a.conversations()).find(r=>r.id===roomId)!;
      const session=createMessageSession({userId:buyer.id,conversation:room,client:a,source:createSupabaseMessageSource(clients[0]!)});
      stops.push(()=>session.dispose());session.start();
      await until(()=>session.snapshot().messages.some(m=>m.id===message.id),'C session history recovery timed out');
      session.dispose();
    });
    await step('Enforce bidirectional blocking in API, RLS and Realtime', async () => {
      await sql('insert into public.blocks(blocker_id,blocked_id) values($1,$2)',[recipient.id,buyer.id]);
      for(const member of [a,b]) { let denied=false;try{await member.sendMessage(roomId!,'blocked send');}catch(e){denied=(e as {code?:string}).code==='BLOCKED';}assert(denied,'Blocked API send succeeded'); }
      assert((await a.conversations()).length===0,'Blocked room remained visible');
      const visible=await clients[1]!.from('messages').select('id').eq('conversation_id',roomId!);assert(!visible.error&&visible.data.length===0,'Blocked RLS exposed messages');
      const before=received.map(list=>list.length);
      await sql('insert into public.messages(id,conversation_id,sender_id,body) values($1,$2,$3,$4)',[randomUUID(),roomId,buyer.id,'C QA: service-only blocked delivery probe']);
      await delay(2000);assert(received.every((list,i)=>list.length===before[i]),'Blocked Realtime exposed a new message');
    });
    await step('Clear A login cookies and deny subsequent authenticated API access', async () => {
      const out=await http(buyer,'/api/auth/logout',{method:'POST'});assert(out.status===200,'Logout failed');
      const after=await http(buyer,'/api/conversations');assert(after.status===401,'Logged-out API remained accessible');
    });
    successful=true;
  } finally {
    try { await cleanup(); } finally {
      await pool?.end();
      const report={project,runId,success:successful,cleaned,checks,failedAt:successful?null:currentCheck,
        limits:['OTP generated by Admin without email delivery; real school mailbox delivery not tested.','Local QA process allows qa.example.invalid only; production school policy unchanged.','Chat entitlement seeded as a temporary fixture; no real payment processed.']};
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
      console.log(JSON.stringify({success:successful,cleaned,passed:checks.length,failedAt:report.failedAt,report:fileURLToPath(reportPath)}));
    }
  }
}
main().catch(error=>{console.error(JSON.stringify({verificationFailed:true,stage:currentCheck,errorType:error.name,code:error.code??null,reason:error instanceof QaFailure?error.message:'Service operation failed'}));process.exitCode=1;});
