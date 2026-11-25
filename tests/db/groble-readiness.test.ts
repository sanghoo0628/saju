import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTestDb, type TestDb } from './harness';
import { inspectGrobleDatabase } from '../../src/server/groble-readiness';
import type { SqlExecutor } from '../../src/server/postgres-transaction';
let db:TestDb;
let serial=0;
beforeAll(async()=>{
  db=await createTestDb();
  await db.db.exec(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);
    insert into supabase_migrations.schema_migrations values('20261125000100'),('20261125000200');`);
});
afterAll(async()=>{await db?.db.close();});
const inspect=()=>inspectGrobleDatabase(db.db);
async function seed(state:string) {
  await db.db.query(`insert into private.groble_events(event_id,transaction_id,event_type,occurred_at,payload_hash,state)
    values($1,'PRIVATE-MERCHANT','payment.refunded',now(),'PRIVATE-HASH',$2)`,['PRIVATE-EVENT-'+(++serial),state]);
}
it('confirms complete schema, server role and browser restrictions in a read-only transaction',async()=>{
  const report=await inspect();expect(report.databaseReady).toBe(true);expect(report.readOnly).toBe(true);
  expect(report.roleRestored).toBe(true);expect(report.counts).toEqual({total:0,applied:0,pendingMapping:0,reviewRequired:0});
  expect(report.paymentActivationChecked).toBe(false);expect(report.sharedDataWrites).toBe(0);
  expect((await db.db.query<{value:string}>("select current_setting('transaction_read_only') value")).rows[0]!.value).toBe('off');
});
it('aggregates unresolved and review states without returning event or transaction identifiers',async()=>{
  await seed('pending_mapping');await seed('review_required');await seed('applied');
  const report=await inspect();expect(report.attentionRequired).toBe(true);
  expect(report.counts).toEqual({total:3,pendingMapping:1,reviewRequired:1,applied:1});
  expect(JSON.stringify(report)).not.toContain('PRIVATE-');
});
it('does not update existing ledger timestamps or processing states',async()=>{
  const before=await db.db.query('select event_id,state,updated_at from private.groble_events order by event_id');
  await inspect();
  expect((await db.db.query('select event_id,state,updated_at from private.groble_events order by event_id')).rows).toEqual(before.rows);
});
it('reports missing migration history instead of guessing from present tables',async()=>{
  await db.db.exec("delete from supabase_migrations.schema_migrations where version='20261125000200'");
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.migrations.timestamps).toBe(false);}
  finally {await db.db.exec("insert into supabase_migrations.schema_migrations values('20261125000200')");}
});
it('reports a not-yet-applied timestamp column and trigger safely',async()=>{
  await db.db.exec('alter table private.groble_events rename column updated_at to old_updated_at');
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.timestampColumn).toBe(false);expect(report.counts?.total).toBe(3);}
  finally {await db.db.exec('alter table private.groble_events rename column old_updated_at to updated_at');}
});
it('detects a disabled timestamp trigger',async()=>{
  await db.db.exec('alter table private.groble_events disable trigger groble_events_set_updated_at');
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.timestampTriggerEnabled).toBe(false);}
  finally {await db.db.exec('alter table private.groble_events enable trigger groble_events_set_updated_at');}
});
it('detects browser table grants',async()=>{
  await db.db.exec('grant select on private.groble_events to anon');
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.browserAccessBlocked).toBe(false);}
  finally {await db.db.exec('revoke select on private.groble_events from anon');}
});
it('detects column-only browser access even without a table-wide grant',async()=>{
  await db.db.exec('grant select(event_id) on private.groble_events to authenticated');
  try {const report=await inspect();expect(report.browserAccessBlocked).toBe(false);expect(report.databaseReady).toBe(false);}
  finally {await db.db.exec('revoke select(event_id) on private.groble_events from authenticated');}
});
it('detects disabled RLS',async()=>{
  await db.db.exec('alter table private.groble_events disable row level security');
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.schema.groble_events!.rls).toBe(false);}
  finally {await db.db.exec('alter table private.groble_events enable row level security');}
});
it('detects missing server write permissions without performing a test insert',async()=>{
  await db.db.exec('revoke insert on private.groble_events from service_role');
  try {const report=await inspect();expect(report.servicePermissions).toBe(false);expect(report.databaseReady).toBe(false);expect(report.counts).toBeNull();}
  finally {await db.db.exec('grant insert on private.groble_events to service_role');}
});
it('missing core tables return unavailable counts, not misleading zeroes',async()=>{
  await db.db.exec('alter table private.groble_refunds rename to saved_refunds');
  try {const report=await inspect();expect(report.databaseReady).toBe(false);expect(report.counts).toBeNull();}
  finally {await db.db.exec('alter table private.saved_refunds rename to groble_refunds');}
});
it('missing history schema is a setup failure, not a database exception',async()=>{
  await db.db.exec('alter schema supabase_migrations rename to saved_migrations');
  try {const report=await inspect();expect(report.migrations).toEqual({inbox:false,timestamps:false});expect(report.databaseReady).toBe(false);}
  finally {await db.db.exec('alter schema saved_migrations rename to supabase_migrations');}
});
it('actual database read-only mode prevents a hidden write and rollback restores the connection',async()=>{
  const executor:SqlExecutor={async query(sql,params){
    if(sql.startsWith('select state,count('))return db.db.query("insert into private.groble_events(event_id) values('forbidden')");
    return db.db.query(sql,params);
  }};
  await expect(inspectGrobleDatabase(executor)).rejects.toMatchObject({phase:'aggregate_counts',cause:{code:'25006'}});
  expect((await inspect()).databaseReady).toBe(true);
});
