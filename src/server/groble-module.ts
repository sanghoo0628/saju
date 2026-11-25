import 'server-only';
import { z } from 'zod';
import { ConfigurationError } from '@/lib/env/schema';
import { createGrobleGateway } from './groble-gateway';
import { createGrobleEventVerifier } from './groble-events';
import { createGrobleInbox } from './groble-inbox';
import { createGrobleWebhookHandler } from './groble-webhook-handler';
import { inspectGrobleDatabase } from './groble-readiness';
import { createDeadlinePool } from './postgres-deadline';
import { createPostgresRepository, type TransactionPool } from './postgres-repository';
import { createPaymentChatHandler } from './payment-chat-handler';
import { unavailablePaymentGateway } from './payment-gateway';
import { logPaymentChatError } from './payment-chat-diagnostics';
import { createService, ServiceError } from '../../packages/payment-chat/src/service';
import type { PaymentGateway } from '../../packages/payment-chat/src/ports';

type Source = Record<string,string|undefined>;
function configuration(source:Source,now:()=>number) {
  if(source.MOCK_PAYMENTS_ENABLED && source.MOCK_PAYMENTS_ENABLED!=='false')
    throw new ConfigurationError(['MOCK_PAYMENTS_ENABLED']);
  const flag=source.PAYMENTS_ENABLED ?? 'false';
  if(!['true','false'].includes(flag))throw new ConfigurationError(['PAYMENTS_ENABLED']);
  if(flag==='false')return null;
  const paymentUrl=source.GROBLE_PAYMENT_URL ?? '',productId=source.GROBLE_PRODUCT_ID ?? '',secret=source.GROBLE_WEBHOOK_SECRET ?? '';
  if(!secret || /\s/.test(secret))throw new ConfigurationError(['GROBLE_WEBHOOK_SECRET']);
  const previousSecret=source.GROBLE_WEBHOOK_PREVIOUS_SECRET || undefined;
  const expiry=source.GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT || undefined;
  if(!!previousSecret!==!!expiry || (previousSecret && /\s/.test(previousSecret))
    || (expiry && !z.iso.datetime({offset:true}).safeParse(expiry).success))
    throw new ConfigurationError(['GROBLE_WEBHOOK_PREVIOUS_SECRET_EXPIRES_AT']);
  return {paymentUrl,productId,secret,previousSecret,previousSecretExpiresAt:expiry?Date.parse(expiry):undefined,now};
}

/** Fully composed server module. Not imported by the live runtime until team rollout approval. */
export async function createGroblePaymentChatModule(options:{
  pool:TransactionPool;
  source:Source;
  appOrigin:string;
  /** A's verified school session is evaluated for each application request, never for a webhook. */
  requireUserId:()=>Promise<string>;
  onUnexpectedError?:(error:unknown)=>void;
  now?:()=>number;
}) {
  const report=(phase:'runtime'|'request',error:unknown)=>{
    try { if(options.onUnexpectedError)options.onUnexpectedError(error);else logPaymentChatError(phase,error); } catch { /* Diagnostics cannot enable payments or alter a response. */ }
  };
  const config=configuration(options.source,options.now??Date.now);
  let origin:URL;
  try {
    origin=new URL(options.appOrigin);
    if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash
      ||(config&&origin.protocol!=='https:'))throw new Error();
  } catch { throw new ConfigurationError(['NEXT_PUBLIC_APP_URL']); }
  let gateway:PaymentGateway=unavailablePaymentGateway;
  let webhook:(request:Request)=>Promise<Response>=async request=>Response.json(
    {code:request.method==='POST'?'PROVIDER_UNAVAILABLE':'METHOD_NOT_ALLOWED'},
    {status:request.method==='POST'?503:405,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      ...(request.method==='POST'?{'Retry-After':'5'}:{Allow:'POST'})}});
  if(config) {
    // All key/checkout validation precedes the first connection attempt. No remote provider call here.
    const checkout=createGrobleGateway(config),verify=createGrobleEventVerifier(config);
    let client:Awaited<ReturnType<TransactionPool['connect']>>|undefined;
    try {
      client=await createDeadlinePool(options.pool,3000).connect();
      const ready=(await inspectGrobleDatabase(client)).databaseReady;
      client.release(true);client=undefined;
      if(!ready)throw new ConfigurationError(['GROBLE_DATABASE_SCHEMA']);
    } catch(error) {
      try {client?.release(true);}catch(cleanup){report('runtime',cleanup);}
      if(error instanceof ConfigurationError)throw error;
      report('runtime',error);
      throw new ConfigurationError(['GROBLE_DATABASE_PREFLIGHT']);
    }
    // The legacy completion-only service path must not bypass the durable event inbox.
    gateway={productId:checkout.productId,checkoutUrl:reference=>checkout.checkoutUrl(reference),
      async verifyCompleted(){throw new ServiceError('PROVIDER_UNAVAILABLE','전용 결제 이벤트 수신 경로를 이용해주세요.');}};
    const inbox=createGrobleInbox({pool:options.pool,verify});
    webhook=createGrobleWebhookHandler({receive:inbox.receive,onUnexpectedError:error=>report('request',error)});
  }
  const service=createService({repository:createPostgresRepository(options.pool),gateway});
  const application=createPaymentChatHandler({service,appOrigin:origin.origin,requireUserId:options.requireUserId,
    onUnexpectedError:error=>report('request',error)});
  return {enabled:!!config,
    handle:(request:Request)=>new URL(request.url).pathname==='/api/webhooks/groble'?webhook(request):application(request),
  };
}
