import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment, parseArguments, plannedStages, runSelectedChecks, summary, executeCommand } from '../verify-integration.ts';
import { integrationCases, renderIntegrationChecklist } from '../integration-checklist.ts';

test('default invocation plans checks without selecting execution', () => {
  assert.deepEqual(parseArguments([]), { run: false, postgres: false, help: false });
  assert.equal(plannedStages().filter(s => s.status === 'planned').length, 6);
  assert.equal(summary(plannedStages(), false).selectedChecksPassed, false);
});
test('unknown and duplicate arguments are rejected without reflecting submitted values', () => {
  for (const args of [['--remote=https://secret.invalid'], ['--run','--run']])
    assert.throws(() => parseArguments(args), e => e instanceof Error && !e.message.includes('secret.invalid'));
  assert.equal(parseArguments(['--run','--postgres']).postgres, true);
});
test('app keys from both the example and inherited provider variables are blanked without changing the parent', () => {
  const parent = { PATH: '/test/bin', DATABASE_URL: 'private-db', NEXT_PUBLIC_SUPABASE_URL: 'private-api',
    GROBLE_UNLISTED_TOKEN: 'private-payment', NEW_EXAMPLE_KEY: 'private-extra', C_LIVE_QA_PROJECT_REF: 'private-qa', NODE_ENV: 'production' as const };
  const env = isolatedEnvironment(parent, 'NEW_EXAMPLE_KEY=\nDATABASE_URL=\nAPP_ENV=production\n');
  for (const key of ['DATABASE_URL','NEXT_PUBLIC_SUPABASE_URL','GROBLE_UNLISTED_TOKEN','NEW_EXAMPLE_KEY','C_LIVE_QA_PROJECT_REF']) assert.equal(env[key], '');
  assert.equal(env.PATH, parent.PATH); assert.equal(parent.DATABASE_URL, 'private-db');
  assert.equal(env.APP_ENV, 'development'); assert.equal(env.PAYMENTS_ENABLED, 'false');
  assert.equal(env.SAJU_PROVIDER, 'mock'); assert.equal(env.NODE_ENV, 'test');
});
test('all selected checks can pass while full-flow signoff and manual evidence remain pending', async () => {
  const calls: string[] = [];
  const results = await runSelectedChecks(async stage => { calls.push(stage.id); return { status: 'passed' }; });
  assert.equal(calls.length, 6); assert.ok(!calls.includes('postgres'));
  const report = summary(results, true);
  assert.equal(report.selectedChecksPassed, true); assert.equal(report.fullUserFlowVerified, false);
  assert.ok(report.manualCases.every(c => c.status === 'not_run'));
  assert.ok(report.signoffGates.some(g => g.status === 'decision_required'));
});
test('native PostgreSQL runs only with the explicit option', async () => {
  const results = await runSelectedChecks(async () => ({ status: 'passed' }), { postgres: true });
  assert.equal(results.at(-1)?.status, 'passed'); assert.equal(summary(results, true).selectedChecksPassed, true);
});
test('a failed check stops later checks without retrying it', async () => {
  const calls: string[] = [];
  const results = await runSelectedChecks(async stage => {
    calls.push(stage.id); return stage.id === 'types' ? { status: 'failed', reason: 'nonzero_exit' } : { status: 'passed' };
  });
  assert.deepEqual(calls, ['lint','types']); assert.equal(results[2]?.reason, 'previous_failure');
  assert.equal(summary(results, true).selectedChecksPassed, false);
});
test('an executor error is sanitized and stops the pipeline', async () => {
  const results = await runSelectedChecks(async () => { throw new Error('credential-like-private-value'); });
  assert.equal(results[0]?.reason, 'execution_error');
  assert.ok(!JSON.stringify(results).includes('credential-like-private-value'));
});
test('cancellation prevents subsequent stages from running', async () => {
  const controller = new AbortController(); let calls = 0;
  const results = await runSelectedChecks(async () => { calls++; controller.abort(); return { status: 'cancelled' }; }, { signal: controller.signal });
  assert.equal(calls, 1); assert.equal(results[1]?.reason, 'interrupted');
  assert.equal(summary(results, true).selectedChecksPassed, false);
});
test('an already-aborted run starts no commands', async () => {
  const controller = new AbortController(); controller.abort();
  const results = await runSelectedChecks(async () => { throw new Error('must not run'); }, { signal: controller.signal });
  assert.ok(results.every(s => s.status === 'not_run'));
});
test('planning snapshots and report edits cannot mutate later runs', () => {
  const plan = plannedStages(); plan[0]!.status = 'passed';
  assert.equal(plannedStages()[0]?.status, 'planned');
  const report = summary(plannedStages(), false); report.manualCases[0]!.status = 'passed';
  assert.equal(summary(plannedStages(), false).manualCases[0]?.status, 'not_run');
  assert.equal(summary([], true).selectedChecksPassed, false);
});
test('the manual checklist covers consent, privacy, shortages and unresolved payment policy', () => {
  const checklist = renderIntegrationChecklist();
  for (const c of integrationCases) assert.ok(checklist.includes(c.id));
  for (const value of ['미동의','최대 3명','로그인 만료','응답 지연','PG 실제 검증','rejection_refund','refunded_room']) assert.ok(checklist.includes(value));
});

test('subprocess execution writes separate logs and reports nonzero exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-integration-tool-'));
  try {
    const options = { cwd: directory, env: process.env, signal: new AbortController().signal, timeoutMs: 5000 };
    const pass = await executeCommand(process.execPath, ['-e','console.log("fixture-ok")'], { ...options, logPath: join(directory,'pass.log') });
    assert.equal(pass.status, 'passed'); assert.match(await readFile(join(directory,'pass.log'),'utf8'), /fixture-ok/);
    const failed = await executeCommand(process.execPath, ['-e','process.exit(7)'], { ...options, logPath: join(directory,'fail.log') });
    assert.deepEqual(failed, { status: 'failed', reason: 'nonzero_exit' });
    const missing = await executeCommand(join(directory,'missing-command'), [], { ...options, logPath: join(directory,'missing.log') });
    assert.deepEqual(missing, { status: 'failed', reason: 'spawn_failed' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('stalled and actively cancelled subprocesses are terminated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-integration-timeout-'));
  try {
    const result = await executeCommand(process.execPath, ['-e','setInterval(()=>{},1000)'], {
      cwd: directory, env: process.env, signal: new AbortController().signal, timeoutMs: 100, logPath: join(directory,'timeout.log'),
    });
    assert.deepEqual(result, { status: 'failed', reason: 'timeout' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      const cancelled = await executeCommand(process.execPath, ['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {
        cwd: directory, env: process.env, signal: controller.signal, timeoutMs: 5000, logPath: join(directory,'active-cancel.log'),
      });
      assert.deepEqual(cancelled, { status: 'cancelled', reason: 'interrupted' });
    } finally { clearTimeout(timer); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('pre-cancelled subprocess execution creates no log or child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'saju-integration-cancel-'));
  try {
    const controller = new AbortController(); controller.abort(); const logPath = join(directory,'cancel.log');
    assert.deepEqual(await executeCommand(process.execPath, ['-e','process.exit(1)'], {
      cwd: directory, env: process.env, signal: controller.signal, timeoutMs: 100, logPath,
    }), { status: 'cancelled', reason: 'interrupted' });
    await assert.rejects(access(logPath));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
