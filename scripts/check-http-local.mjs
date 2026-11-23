import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Cannot reserve a local HTTP port');
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function main() {
  await access(new URL('../.next/BUILD_ID', import.meta.url)).catch(() => {
    throw new Error('Next.js build is missing. Run pnpm build with the unconfigured test environment first.');
  });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // Override .env.local only in the child processes; never edit the user's file.
  const env = { ...process.env, NODE_ENV: 'production', APP_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_APP_URL: base, NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SECRET_KEY: '', DATABASE_URL: '', DATABASE_SSL_CA_PATH: '', SCORE_HMAC_SECRET: '',
    ALLOWED_EMAIL_DOMAINS: 'campus.example.edu', MATCHING_STRATEGY: 'legacy_demo_v1',
    SAJU_PROVIDER: 'mock', SAJU_API_KEY: '', SAJU_FINGERPRINT_SECRET: '', SAJU_API_BASE_URL: '',
    PAYMENTS_ENABLED: 'false', MOCK_PAYMENTS_ENABLED: 'false', GROBLE_PAYMENT_URL: '', GROBLE_PRODUCT_ID: '',
    GROBLE_WEBHOOK_SECRET: '', GROBLE_WEBHOOK_PREVIOUS_SECRET: '', ACTIVITY_BOOKING_PROVIDER: 'disabled',
  };
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let ended = false;
  let spawnFailed = false;
  const collect = chunk => { log = (log + chunk.toString()).slice(-8000); };
  server.stdout.on('data', collect);
  server.stderr.on('data', collect);
  const closed = new Promise(resolve => {
    server.once('error', () => { spawnFailed = true; ended = true; resolve(); });
    server.once('exit', () => { ended = true; resolve(); });
  });
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error('Local HTTP verification interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const deadline = Date.now() + 30000;
    while (true) {
      abort.signal.throwIfAborted();
      if (ended) throw new Error(spawnFailed ? 'Cannot start the local app' : 'The local app exited before readiness');
      if (Date.now() > deadline) throw new Error('The local app did not become ready within 30 seconds');
      try {
        const response = await fetch(base, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]) });
        await response.body?.cancel();
        if (response.status === 200) break;
      } catch { abort.signal.throwIfAborted(); }
      await delay(200, undefined, { signal: abort.signal });
    }
    await new Promise((resolve, reject) => {
      const checks = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./smoke-http.ts', import.meta.url))],
        { cwd: root, env: { ...env, SMOKE_BASE_URL: base }, stdio: 'inherit', signal: abort.signal });
      checks.once('error', reject);
      checks.once('exit', code => code === 0 ? resolve() : reject(new Error(`HTTP checks failed (exit ${code})`)));
    });
  } catch (error) {
    if (log) console.error(log);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (!ended) server.kill('SIGTERM');
    await Promise.race([closed, delay(3000)]);
    if (!ended) { server.kill('SIGKILL'); await closed; }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
