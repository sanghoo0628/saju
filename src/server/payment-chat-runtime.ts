import 'server-only';
import { createPaymentChatDatabase } from './postgres-repository';
import { createPaymentChatHandler } from './payment-chat-handler';
import { createService } from '../../packages/payment-chat/src/service';
import { unavailablePaymentGateway } from './payment-gateway';
import { requireVerifiedSchoolUser } from '@/lib/auth/require-user';
import { getServerEnv } from '@/lib/env/server';
import { logPaymentChatError } from './payment-chat-diagnostics';
import { paymentChatTls } from './payment-chat-tls';

function createRuntime() {
  const env = getServerEnv();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const caPath = process.env.DATABASE_SSL_CA_PATH;
  const database = createPaymentChatDatabase(connectionString, { pool: {
    max: 5,
    ssl: paymentChatTls(connectionString, caPath, process.env.DATABASE_SSL_CA_PEM),
  } });
  const service = createService({ repository: database.repository, gateway: unavailablePaymentGateway });
  const handle = createPaymentChatHandler({ service, appOrigin: env.NEXT_PUBLIC_APP_URL,
    requireUserId: async () => (await requireVerifiedSchoolUser()).user.id,
    onUnexpectedError: error => logPaymentChatError('request', error) });
  return { handle, database };
}

// Cache infrastructure only; authentication is evaluated for every request.
const shared = globalThis as typeof globalThis & { sajuPaymentChatRuntime?: ReturnType<typeof createRuntime> };
export async function handlePaymentChatRequest(request: Request): Promise<Response> {
  try {
    const runtime = shared.sajuPaymentChatRuntime ??= createRuntime();
    return await runtime.handle(request);
  } catch (error) {
    logPaymentChatError('runtime', error);
    return Response.json({ code: 'PROVIDER_UNAVAILABLE', message: '서비스 연결 설정을 준비하고 있어요.' },
      { status: 503, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
}
