import { spawn, execFileSync } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrationCases, signoffGates, renderIntegrationChecklist } from './integration-checklist.ts';

export interface Stage { id: string; script: string; timeoutMs: number; optional?: boolean }
export interface Outcome { status: 'passed' | 'failed' | 'cancelled'; reason?: string }
export interface StageResult extends Stage { status: 'planned' | 'not_run' | Outcome['status']; reason?: string }
export const stages: readonly Stage[] = [
  { id: 'lint', script: 'lint', timeoutMs: 120000 },
  { id: 'types', script: 'typecheck', timeoutMs: 120000 },
  { id: 'tests', script: 'test', timeoutMs: 300000 },
  { id: 'app_build', script: 'build', timeoutMs: 300000 },
  { id: 'demo_build', script: 'demo:build', timeoutMs: 120000 },
  { id: 'http', script: 'test:http:local', timeoutMs: 60000 },
  { id: 'postgres', script: 'test:postgres', timeoutMs: 300000, optional: true },
];

/** Blank app connection settings before Next loads .env.local. Never load the real file here. */
export function isolatedEnvironment(parent: NodeJS.ProcessEnv, example: string): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const match of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) env[match[1]!] = '';
  // Clear app/provider variables even if an example entry is accidentally omitted.
  for (const key of Object.keys(env))
    if (/^(NEXT_PUBLIC_|SUPABASE_|DATABASE_|SCORE_|SAJU_|GROBLE_|LEGACY_|BOOKING_|LLM_|KASI_|C_LIVE_QA_|C_READONLY_QA_)/.test(key)) env[key] = '';
  return { ...env, NODE_ENV: 'test', APP_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
    NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3000', ALLOWED_EMAIL_DOMAINS: 'campus.example.edu',
    MATCHING_STRATEGY: 'legacy_demo_v1', SAJU_PROVIDER: 'mock', PAYMENTS_ENABLED: 'false',
    MOCK_PAYMENTS_ENABLED: 'false', ACTIVITY_BOOKING_PROVIDER: 'disabled' };
}

export function plannedStages(postgres = false): StageResult[] {
  return stages.map(s => ({ ...s, status: s.optional && !postgres ? 'not_run' : 'planned',
    ...(s.optional && !postgres ? { reason: 'requires_postgres_flag' } : {}) }));
}

export async function runSelectedChecks(execute: (stage: Stage) => Promise<Outcome>, options: {
  postgres?: boolean; signal?: AbortSignal; onProgress?: (id: string, status: string) => void;
} = {}) {
  const results = plannedStages(options.postgres);
  let stopped = false;
  for (const result of results) {
    if (result.status !== 'planned') continue;
    if (stopped || options.signal?.aborted) {
      result.status = 'not_run'; result.reason = options.signal?.aborted ? 'interrupted' : 'previous_failure'; continue;
    }
    options.onProgress?.(result.id, 'running');
    let outcome: Outcome;
    try { outcome = await execute(result); }
    catch { outcome = { status: 'failed', reason: 'execution_error' }; }
    Object.assign(result, outcome);
    options.onProgress?.(result.id, result.status);
    if (outcome.status !== 'passed') stopped = true;
  }
  return results;
}

export function summary(results: StageResult[], run: boolean) {
  const selected = results.filter(s => !s.optional || s.reason !== 'requires_postgres_flag');
  return { mode: run ? 'run' : 'plan', selectedChecksPassed: run && selected.length > 0 && selected.every(s => s.status === 'passed'),
    fullUserFlowVerified: false, stages: results, manualCases: integrationCases.map(c => ({ ...c, status: 'not_run' })),
    signoffGates: signoffGates.map(g => ({ ...g })) };
}

/** No shell, no automatic retries. Kill only the process group started for this stage. */
export async function executeCommand(command: string, args: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; logPath: string; timeoutMs: number; signal: AbortSignal;
}): Promise<Outcome> {
  if (options.signal.aborted) return { status: 'cancelled', reason: 'interrupted' };
  const log = await open(options.logPath, 'wx', 0o600);
  try {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env,
      stdio: ['ignore', log.fd, log.fd], detached: process.platform !== 'win32' });
    let stopping: 'timeout' | 'interrupted' | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The stage may already have exited. */ }
    };
    const stop = (reason: 'timeout' | 'interrupted') => {
      if (stopping) return;
      stopping = reason; kill('SIGTERM');
      termination = new Promise(resolve => {
        escalation = setTimeout(() => { kill('SIGKILL'); resolve(); }, 3000);
      });
    };
    const interrupt = () => stop('interrupted');
    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal.addEventListener('abort', interrupt, { once: true });
    if (options.signal.aborted) interrupt();
    try {
      const result = await new Promise<Outcome>(resolve => {
        child.once('error', () => resolve({ status: 'failed', reason: 'spawn_failed' }));
        child.once('close', code => resolve(stopping
          ? { status: stopping === 'interrupted' ? 'cancelled' : 'failed', reason: stopping }
          : code === 0 ? { status: 'passed' } : { status: 'failed', reason: 'nonzero_exit' }));
      });
      // A package-manager parent can exit before its children; finish group cleanup.
      if (termination) await termination;
      return result;
    } finally {
      clearTimeout(timeout); if (escalation) clearTimeout(escalation);
      options.signal.removeEventListener('abort', interrupt);
    }
  } finally { await log.close(); }
}

export function parseArguments(args: string[]) {
  const allowed = new Set(['--run', '--postgres', '--help']);
  if (args.some(arg => !allowed.has(arg)) || new Set(args).size !== args.length)
    throw new Error('Use --run, --postgres or --help.');
  return { run: args.includes('--run'), postgres: args.includes('--postgres'), help: args.includes('--help') };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('pnpm verify:integration [--run] [--postgres]\nDefault: write a plan and manual checklist. --run executes isolated checks. --postgres includes native DB checks.'); return;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const env = isolatedEnvironment(process.env, await readFile(join(root, '.env.example'), 'utf8'));
  if (options.run) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const expected = String(manifest.packageManager).replace(/^pnpm@/, '');
    const actual = execFileSync('pnpm', ['--version'], { cwd: root, env, encoding: 'utf8', timeout: 10000,
      stdio: ['ignore','pipe','ignore'] }).trim();
    if (actual !== expected) throw new Error('Put the project-pinned pnpm on PATH.');
  }
  const directory = join(root, 'test-results', 'integration', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let revision: string | null = null, dirty: boolean | null = null;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','ignore'] }).trim();
    dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','ignore'] }).trim();
  } catch { /* A report without git metadata must not invent a verified revision. */ }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const results = options.run ? await runSelectedChecks(stage => executeCommand('pnpm', [stage.script], {
      cwd: root, env: { ...env, NODE_ENV: ['app_build','demo_build','http'].includes(stage.id) ? 'production' : 'test' },
      logPath: join(directory, `${stage.id}.log`), timeoutMs: stage.timeoutMs, signal: controller.signal,
    }), { ...options, signal: controller.signal, onProgress: (id, status) => console.log(`${id}: ${status}`) }) : plannedStages(options.postgres);
    const report = { schemaVersion: 1, createdAt: new Date().toISOString(), source: { revision, workingTreeDirty: dirty }, ...summary(results, options.run) };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(directory, 'manual-checklist.txt'), renderIntegrationChecklist(), { mode: 0o600 });
    console.log(JSON.stringify({ mode: report.mode, selectedChecksPassed: report.selectedChecksPassed,
      fullUserFlowVerified: false, report: join(directory, 'report.json'), checklist: join(directory, 'manual-checklist.txt') }));
    if (options.run && !report.selectedChecksPassed) process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('Integration verification setup failed. Check arguments, local pnpm and output permissions.'); process.exitCode = 1; });
