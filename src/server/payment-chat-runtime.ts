import 'server-only';
import { readFileSync } from 'node:fs';
import { createPaymentChatDatabase } from './postgres-repository';
import { createPaymentChatHandler } from './payment-chat-handler';
import { createService } from '../../packages/payment-chat/src/service';
import { unavailablePaymentGateway } from './payment-gateway';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { getServerEnv } from '@/lib/env/server';

function createRuntime() {
  const env = getServerEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  // Missing CA uses Node's normal trusted roots, never an unverified connection.
  const caPath = process.env.DATABASE_SSL_CA_PATH;
  const database = createPaymentChatDatabase(connectionString, { pool: {
    max: 5,
    ssl: { rejectUnauthorized: true, ...(caPath ? { ca: readFileSync(caPath, 'utf8') } : {}) },
  } });
  const service = createService({ repository: database.repository, gateway: unavailablePaymentGateway });
  const handle = createPaymentChatHandler({ service, appOrigin: env.NEXT_PUBLIC_APP_URL,
    requireUserId: async () => (await requireVerifiedSchoolUser()).user.id });
  return { handle, database };
}

// Cache infrastructure only; authentication is evaluated for every request.
const shared = globalThis as typeof globalThis & { sajuPaymentChatRuntime?: ReturnType<typeof createRuntime> };
export async function handlePaymentChatRequest(request: Request): Promise<Response> {
  try {
    const runtime = shared.sajuPaymentChatRuntime ??= createRuntime();
    return await runtime.handle(request);
  } catch {
    return Response.json({ code: 'PROVIDER_UNAVAILABLE', message: '서비스 연결 설정을 준비하고 있어요.' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
}
