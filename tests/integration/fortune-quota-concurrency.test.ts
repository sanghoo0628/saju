/** Native quota regressions. Disposable PostgreSQL; never invokes a fortune provider. */
import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { startNativePostgres } from './native-postgres';
import { uid } from '../db/harness';

let db: Awaited<ReturnType<typeof startNativePostgres>>;
const a = uid(1), b = uid(2), c = uid(3);
beforeAll(async () => {
  db = await startNativePostgres();
  for (const user of [a, b, c]) await db.pool.query('insert into auth.users(id) values($1)', [user]);
}, 60000);
afterAll(async () => { if (db) await db.close(); }, 30000);
beforeEach(async () => {
  await db.pool.query('truncate public.fortune_provider_usage,public.fortune_provider_daily_total');
});

async function claim(user: string, userLimit = 5, totalLimit = 15) {
  const connection = await db.pool.connect();
  try {
    await connection.query('begin');
    await connection.query('set local role service_role');
    await connection.query("set local statement_timeout = '10s'");
    const result = (await connection.query<{ value: string }>(
      'select public.claim_fortune_provider_call($1,$2,$3) value', [user, userLimit, totalLimit],
    )).rows[0]!.value;
    await connection.query('commit');
    return result;
  } catch (error) {
    await connection.query('rollback');
    throw error;
  } finally { connection.release(); }
}
async function counts() {
  return (await db.pool.query(`select
    coalesce((select sum(calls) from public.fortune_provider_daily_total),0)::integer total,
    coalesce((select sum(calls) from public.fortune_provider_usage),0)::integer users`)).rows[0];
}

it('60 concurrent calls from one user admit exactly five', async () => {
  const outcomes = await Promise.all(Array.from({ length: 60 }, () => claim(a, 5, 100)));
  expect(outcomes.filter(value => value === 'ok')).toHaveLength(5);
  expect(outcomes.filter(value => value === 'user_limit')).toHaveLength(55);
  expect(await counts()).toEqual({ total: 5, users: 5 });
});
it('60 concurrent calls across users cannot exceed the global limit', async () => {
  const outcomes = await Promise.all(Array.from({ length: 60 }, (_, i) => claim([a, b, c][i % 3]!, 100, 15)));
  expect(outcomes.filter(value => value === 'ok')).toHaveLength(15);
  expect(outcomes.filter(value => value === 'total_limit')).toHaveLength(45);
  expect(await counts()).toEqual({ total: 15, users: 15 });
});
it('concurrent rejected-user calls do not consume another user global allocation', async () => {
  await claim(a, 2, 100);
  await claim(a, 2, 100);
  const outcomes = await Promise.all([
    ...Array.from({ length: 20 }, () => claim(a, 2, 100)),
    ...Array.from({ length: 10 }, () => claim(b, 20, 100)),
  ]);
  expect(outcomes.filter(value => value === 'ok')).toHaveLength(10);
  expect(outcomes.filter(value => value === 'user_limit')).toHaveLength(20);
  expect(await counts()).toEqual({ total: 12, users: 12 });
});
it('a missing user rolls back the global increment', async () => {
  await expect(claim(uid(999))).rejects.toMatchObject({ code: '23503' });
  expect(await counts()).toEqual({ total: 0, users: 0 });
});
it('browser roles cannot claim tokens or read counters in native PostgreSQL', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const [sql, values] of [
      ['select public.claim_fortune_provider_call($1,5,15)', [a]],
      ['select * from public.fortune_provider_usage', []],
      ['select * from public.fortune_provider_daily_total', []],
    ] as const) {
      const connection = await db.pool.connect();
      try {
        await connection.query('begin');
        // Role names are fixed test constants, never user input.
        await connection.query(`set local role ${role}`);
        await expect(connection.query(sql, [...values])).rejects.toMatchObject({ code: '42501' });
      } finally {
        try { await connection.query('rollback'); } finally { connection.release(); }
      }
    }
  }
});
it('usage day is Korean calendar day independently of session timezone', async () => {
  const connection = await db.pool.connect();
  try {
    await connection.query('begin');
    await connection.query("set local time zone 'Pacific/Honolulu'");
    await connection.query('set local role service_role');
    await connection.query('select public.claim_fortune_provider_call($1,5,15)', [a]);
    const rows = (await connection.query(`select usage_date from public.fortune_provider_usage
      union all select usage_date from public.fortune_provider_daily_total`)).rows;
    expect(rows).toHaveLength(2);
    const dates = (await connection.query(`select
      (select bool_and(usage_date=(now() at time zone 'Asia/Seoul')::date) from public.fortune_provider_usage) users,
      (select bool_and(usage_date=(now() at time zone 'Asia/Seoul')::date) from public.fortune_provider_daily_total) total`)).rows[0];
    expect(dates).toEqual({ users: true, total: true });
    await connection.query('commit');
  } finally {
    try { await connection.query('rollback'); } finally { connection.release(); }
  }
});
