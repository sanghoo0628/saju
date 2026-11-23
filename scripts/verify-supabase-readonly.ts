/** Explicit development-only metadata/SQL compatibility check. Never mutates shared data. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { createPostgresTransaction } from '../src/server/postgres-transaction';

const project = 'acghfykdtorpxkbmknja';
let phase = 'configuration';
let pool: Pool | undefined;
let client: PoolClient | undefined;
try {
  assert.equal(process.env.C_READONLY_QA_PROJECT_REF, project);
  const target = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.equal(target.username, `postgres.${project}`);
  assert.ok(target.hostname.endsWith('.pooler.supabase.com') || target.hostname === `db.${project}.supabase.co`);
  assert.ok(process.env.DATABASE_SSL_CA_PATH);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
    ssl: { rejectUnauthorized: true, ca: await readFile(process.env.DATABASE_SSL_CA_PATH, 'utf8') },
  });
  phase = 'connect';
  client = await pool.connect();
  const before = (await client.query('select current_user as role')).rows[0].role;
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');

  phase = 'migration_history';
  const versions = (await client.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(r => r.version);
  assert.ok(versions.includes('20261123000100'));
  phase = 'columns_and_constraints';
  const columns = (await client.query(`select table_name,column_name,is_nullable from information_schema.columns
    where table_schema='public' and table_name in ('private_birth_data','fortune_results')`)).rows;
  for (const [table, column] of [['private_birth_data','lunar_date'],['private_birth_data','timezone'],
    ['private_birth_data','consent_version'],['private_birth_data','consented_at'],['fortune_results','score_input']])
    assert.ok(columns.some(r => r.table_name === table && r.column_name === column));
  for (const [table, column] of [['private_birth_data','birth_date'],['fortune_results','fortune'],['fortune_results','program_version']])
    assert.equal(columns.find(r => r.table_name === table && r.column_name === column)?.is_nullable, 'YES');
  const constraints = (await client.query(`select conname,convalidated from pg_constraint
    where conrelid in ('public.private_birth_data'::regclass,'public.fortune_results'::regclass)`)).rows;
  for (const name of ['birth_date_by_calendar','lunar_date_format','consent_recorded_together','fortune_with_program_version'])
    assert.equal(constraints.find(r => r.conname === name)?.convalidated, true);

  phase = 'access_and_realtime';
  const security = (await client.query(`select relrowsecurity as rls,
    has_table_privilege('anon','public.fortune_analyses','select') as anon_select,
    has_table_privilege('authenticated','public.fortune_analyses','select') as authenticated_select,
    has_table_privilege('service_role','public.fortune_analyses','insert') as service_insert
    from pg_class where oid='public.fortune_analyses'::regclass`)).rows[0];
  assert.deepEqual(security, { rls: true, anon_select: false, authenticated_select: false, service_insert: true });
  assert.equal((await client.query(`select exists(select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='messages') as present`)).rows[0].present, true);
  const tables = (await client.query(`select relname,relrowsecurity from pg_class where relnamespace='public'::regnamespace
    and relname in ('orders','payments','chat_requests','conversations','messages')`)).rows;
  assert.equal(tables.length, 5); assert.ok(tables.every(r => r.relrowsecurity));
  const indexes = (await client.query(`select indexname from pg_indexes where schemaname='public'`)).rows.map(r => r.indexname);
  for (const name of ['orders_active_pair_uniq','chat_requests_requester_id_recipient_id_key',
    'conversations_user_a_user_b_key','payments_pkey','payments_order_id_key','messages_pkey']) assert.ok(indexes.includes(name));
  const bucket = (await client.query(`select public,file_size_limit,allowed_mime_types from storage.buckets where id='profile-photos'`)).rows[0];
  assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 5242880);
  assert.deepEqual([...bucket.allowed_mime_types].sort(), ['image/jpeg','image/png','image/webp']);

  phase = 'service_role';
  await client.query('SET LOCAL ROLE service_role');
  assert.deepEqual((await client.query(`select current_user as role,current_setting('transaction_read_only') as read_only`)).rows[0],
    { role: 'service_role', read_only: 'on' });
  const connection = client;
  const tx = createPostgresTransaction({ query: (sql, params) => connection.query(sql, params) });
  const a = '00000000-0000-4000-8000-000000000000', b = '00000000-0000-4000-8000-000000000001';
  phase = 'c_read_queries';
  assert.equal(await tx.profileAvailable(a), false); assert.equal(await tx.blocked(a, b), false);
  assert.deepEqual(await tx.requestsForUser(a), []); assert.deepEqual(await tx.conversationsForUser(a), []);
  assert.deepEqual(await tx.messages(a), []); assert.equal(await tx.message(a), undefined);
  assert.equal(await tx.conversation(a), undefined);

  phase = 'c_lock_query_plans';
  // FOR UPDATE itself is forbidden in READ ONLY, even for missing rows.
  // EXPLAIN without ANALYZE checks schema/privileges without acquiring row locks.
  const plans = createPostgresTransaction({ query: async (sql, params) => {
    await connection.query(`EXPLAIN ${sql}`, params); return { rows: [] };
  } });
  await plans.order(a); await plans.request(a);
  await client.query('ROLLBACK');
  assert.equal((await client.query('select current_user as role')).rows[0].role, before);
  console.log(JSON.stringify({ ok: true, readOnly: true, versions, migrationApplied: true,
    newColumnsAndConstraints: true, analysisAccess: security, cTablesRls: true, cRaceIndexes: 6,
    messagesRealtime: true, photoBucketLimits: true, cReadQueries: 7, cLockQueriesPlanned: 2,
    roleRestored: true, sharedDataWrites: 0 }));
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'CHECK_FAILED';
  console.error(JSON.stringify({ ok: false, phase, code })); process.exitCode = 1;
} finally {
  client?.release(); await pool?.end();
}
