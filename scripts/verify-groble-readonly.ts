/** Explicitly targeted, read-only probe. No payment/saju provider keys are required or printed. */
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { paymentChatTls } from '../src/server/payment-chat-tls';
import { inspectGrobleDatabase, GrobleReadinessError } from '../src/server/groble-readiness';
import { logPaymentChatError } from '../src/server/payment-chat-diagnostics';

export function validateGrobleProbeTarget(source: Record<string,string|undefined>) {
  const ref = source.C_GROBLE_READONLY_PROJECT_REF;
  if (!ref || !/^[a-z0-9]{20}$/.test(ref) || !source.DATABASE_URL) throw new Error('Explicit project required');
  let target: URL;
  try { target=new URL(source.DATABASE_URL); } catch { throw new Error('Invalid database configuration'); }
  const pooler = target.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(target.username)===`postgres.${ref}`;
  const direct = target.hostname===`db.${ref}.supabase.co` && target.username==='postgres';
  if (!['postgres:','postgresql:'].includes(target.protocol) || !(pooler||direct)
    || !!target.search || !!target.hash)
    throw new Error('Database project or TLS configuration mismatch');
  return source.DATABASE_URL;
}
export async function runGrobleReadonly(source: Record<string,string|undefined> = process.env) {
  let pool: Pool | undefined, client: PoolClient | undefined;
  let exitCode=1;
  try {
    const connectionString=validateGrobleProbeTarget(source);
    pool=new Pool({connectionString,max:1,connectionTimeoutMillis:5000,statement_timeout:5000,
      ssl:paymentChatTls(connectionString,source.DATABASE_SSL_CA_PATH,source.DATABASE_SSL_CA_PEM)});
    pool.on('error',()=>{}); // Never emit a raw connection error containing infrastructure details.
    client=await pool.connect();
    const report=await inspectGrobleDatabase(client);
    console.log(JSON.stringify(report));
    exitCode=report.databaseReady ? 0 : 2;
  } catch (error) {
    let code='UNREPORTED';
    logPaymentChatError('request',error instanceof GrobleReadinessError ? error.cause : error,entry=>{code=entry.code;});
    console.error(JSON.stringify({scope:'database_only',databaseReady:false,
      phase:error instanceof GrobleReadinessError ? error.phase : 'configuration_or_connection',code}));
    exitCode=1;
  } finally {
    // One-shot probe: discard the connection even after failure to prevent role/transaction reuse.
    try { client?.release(true); await pool?.end(); }
    catch { console.error(JSON.stringify({scope:'database_only',databaseReady:false,phase:'cleanup',code:'CHECK_FAILED'})); exitCode=1; }
  }
  return exitCode;
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)
  process.exitCode=await runGrobleReadonly();
