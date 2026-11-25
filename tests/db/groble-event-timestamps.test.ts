import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createTestDb, type TestDb, uid } from './harness';
let db: TestDb;
beforeAll(async()=>{db=await createTestDb();});
afterAll(async()=>{await db?.db.close();});
async function seed(id:string) {
  await db.db.query(`insert into private.groble_events(event_id,transaction_id,event_type,occurred_at,payload_hash,created_at,updated_at)
    values($1,'merchant','payment.refunded',now(),'fixture','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`,[id]);
}
async function timestamps(id:string) {
  return (await db.db.query<{created_at:Date;updated_at:Date}>(
    'select created_at,updated_at from private.groble_events where event_id=$1',[id])).rows[0]!;
}
it('new inbox rows receive a non-null update timestamp without extra application fields',async()=>{
  await db.asService(tx=>tx.query(`insert into private.groble_events(event_id,transaction_id,event_type,occurred_at,payload_hash)
    values('default','merchant','payment.refunded',now(),'fixture')`));
  const row=await timestamps('default');expect(row.updated_at).toBeInstanceOf(Date);
  expect(row.updated_at.getTime()).toBe(row.created_at.getTime());
});
it('a real state transition advances updated_at using existing service_role privileges',async()=>{
  await seed('state-change');
  await db.asService(tx=>tx.query("update private.groble_events set state='applied' where event_id='state-change'"));
  const row=await timestamps('state-change');expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());
});
it('replaying the same state does not replace the last transition timestamp',async()=>{
  await seed('replay');
  await db.asService(tx=>tx.query("update private.groble_events set state=state,order_id=order_id where event_id='replay'"));
  const row=await timestamps('replay');expect(row.updated_at.getTime()).toBe(row.created_at.getTime());
});
it('linking an order advances updated_at even if state remains unchanged',async()=>{
  await seed('mapping');
  await db.db.query('insert into auth.users(id) values($1),($2)',[uid(991),uid(992)]);
  await db.db.query("insert into public.orders(id,buyer_id,target_id,amount,status,reference) values($1,$2,$3,500,'pending','timestamp-order')",[uid(999),uid(991),uid(992)]);
  await db.asService(tx=>tx.query("update private.groble_events set order_id=$1 where event_id='mapping'",[uid(999)]));
  const row=await timestamps('mapping');expect(row.updated_at.getTime()).toBeGreaterThan(row.created_at.getTime());
});
it('unrelated metadata updates do not impersonate a state transition',async()=>{
  await seed('metadata');
  await db.asService(tx=>tx.query("update private.groble_events set payload_hash='other-fixture' where event_id='metadata'"));
  const row=await timestamps('metadata');expect(row.updated_at.getTime()).toBe(row.created_at.getTime());
});
it('authenticated browsers still cannot read the private ledger',async()=>{
  await expect(db.asUser(uid(1),tx=>tx.query('select updated_at from private.groble_events'))).rejects.toMatchObject({code:'42501'});
});

it('upgrades existing ledger rows without pretending their last transition time is known',async()=>{
  const migration=await readFile(new URL('../../supabase/migrations/20261125000200_groble_events_updated_at.sql',import.meta.url),'utf8');
  await db.db.transaction(async tx=>{
    await tx.exec('drop trigger groble_events_set_updated_at on private.groble_events; alter table private.groble_events drop column updated_at;');
    await tx.query(`insert into private.groble_events(event_id,transaction_id,event_type,occurred_at,payload_hash,created_at)
      values('historical','merchant','payment.refunded',now(),'fixture','2000-01-01T00:00:00Z')`);
    await tx.exec(migration);
    const row=(await tx.query<{state:string;created_at:Date;updated_at:Date}>(
      "select state,created_at,updated_at from private.groble_events where event_id='historical'")).rows[0]!;
    expect(row.state).toBe('pending_mapping');expect(row.updated_at.getTime()).toBe(row.created_at.getTime());
  });
});
