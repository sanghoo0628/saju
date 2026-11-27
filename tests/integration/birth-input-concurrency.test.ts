/** Native row-lock regressions. Disposable PostgreSQL; no Supabase or provider calls. */
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { startNativePostgres } from './native-postgres';
import { uid } from '../db/harness';

let db: Awaited<ReturnType<typeof startNativePostgres>>;
const backendPids = new WeakMap<PoolClient, number>();
beforeAll(async () => { db = await startNativePostgres(); }, 60000);
afterAll(async () => { if (db) await db.close(); }, 30000);
const oldDate = '2000-01-01', newDate = '2001-02-03';
const saveSql = `insert into public.private_birth_data
  (user_id,calendar_type,birth_date,is_leap_month,timezone,consent_version,consented_at)
  values ($1,'solar',$2,false,$3,'matching_birth_storage_v1',now())
  on conflict (user_id) do update set birth_date=excluded.birth_date,timezone=excluded.timezone,
    consented_at=excluded.consented_at`;
const scoreSql = `insert into public.fortune_results
  (user_id,base_number,score,score_version,score_input,scored_birth_key)
  values ($1,1234,-1234,1,'solar',$2)`;
async function fixture(n: number) {
  const id = uid(n);
  await db.pool.query('insert into auth.users(id) values($1)', [id]);
  await db.pool.query(saveSql, [id, oldDate, 'Asia/Seoul']);
  return id;
}
async function transaction() {
  const client = await db.pool.connect();
  backendPids.set(client, (await client.query('select pg_backend_pid() pid')).rows[0].pid);
  await client.query('begin');
  await client.query('set local role service_role');
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '10s'");
  return client;
}
async function blocked(client: PoolClient, blocker: PoolClient) {
  expect(backendPids.get(client)).not.toBe(backendPids.get(blocker));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await db.pool.query('select $2::integer = any(pg_blocking_pids($1)) waiting',
      [backendPids.get(client), backendPids.get(blocker)])).rows[0];
    if (row?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected the second connection to wait for a database lock');
}
async function close(...clients: PoolClient[]) {
  await Promise.all(clients.map(async client => {
    try { await client.query('rollback'); } finally { client.release(); }
  }));
}
async function state(id: string) {
  return (await db.pool.query(`select to_char(b.birth_date,'YYYY-MM-DD') date,f.scored_birth_key key
    from public.private_birth_data b left join public.fortune_results f on f.user_id=b.user_id
    where b.user_id=$1`, [id])).rows[0];
}

it('score commit wins: a waiting birth-date upsert is rejected after the lock releases', async () => {
  const id = await fixture(601), first = await transaction(), second = await transaction();
  try {
    await first.query(scoreSql, [id, oldDate]);
    const saving = second.query(saveSql, [id, newDate, 'UTC']).then(() => null, error => error);
    await blocked(second, first);
    await first.query('commit');
    expect(await saving).toMatchObject({ code: 'P0001', message: 'BIRTH_INPUT_LOCKED' });
    expect(await state(id)).toEqual({ date: oldDate, key: oldDate });
  } finally { await close(first, second); }
});

it('birth commit wins: a waiting stale score is rejected and a fresh score can be retried', async () => {
  const id = await fixture(602), first = await transaction(), second = await transaction();
  try {
    await first.query(saveSql, [id, newDate, 'UTC']);
    const scoring = second.query(scoreSql, [id, oldDate]).then(() => null, error => error);
    await blocked(second, first);
    await first.query('commit');
    expect(await scoring).toMatchObject({ code: 'P0001', message: 'BIRTH_INPUT_CHANGED' });
    expect(await state(id)).toEqual({ date: newDate, key: null });
    await second.query('rollback');
    await second.query('begin');
    await second.query('set local role service_role');
    await second.query(scoreSql, [id, newDate]);
    await second.query('commit');
    expect(await state(id)).toEqual({ date: newDate, key: newDate });
  } finally { await close(first, second); }
});

it('a waiting identical-date upsert succeeds after score creation and refreshes timezone', async () => {
  const id = await fixture(603), first = await transaction(), second = await transaction();
  try {
    await first.query(scoreSql, [id, oldDate]);
    const saving = second.query(saveSql, [id, oldDate, 'UTC']).then(() => null, error => error);
    await blocked(second, first);
    await first.query('commit');
    expect(await saving).toBeNull();
    await second.query('commit');
    expect(await state(id)).toEqual({ date: oldDate, key: oldDate });
    expect((await db.pool.query('select timezone from public.private_birth_data where user_id=$1', [id])).rows[0].timezone).toBe('UTC');
  } finally { await close(first, second); }
});

it('unsequenced competing score/date requests preserve consistency across repeated races', async () => {
  for (let i = 0; i < 12; i++) {
    const id = await fixture(620 + i);
    const outcome = await Promise.allSettled([
      runAsService(scoreSql, [id, oldDate]),
      runAsService(saveSql, [id, newDate, 'UTC']),
    ]);
    expect(outcome.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcome.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('P0001');
    const row = await state(id);
    expect(row.key === null ? row.date === newDate : row.date === oldDate && row.key === oldDate).toBe(true);
  }
});

async function runAsService(sql: string, values: string[]) {
  const client = await transaction();
  try {
    await client.query(sql, values);
    await client.query('commit');
  } finally { await close(client); }
}
