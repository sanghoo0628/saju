/** Read-only database readiness probe. Reports aggregate counts, never event/order/customer data. */
import type { SqlExecutor } from './postgres-transaction';

export class GrobleReadinessError extends Error {
  constructor(readonly phase: string, cause: unknown) { super('Groble database probe failed', {cause}); }
}
const tables = ['groble_events','groble_deliveries','groble_refunds'] as const;
const columns: Record<typeof tables[number], string[]> = {
  groble_events:['event_id','transaction_id','event_type','occurred_at','payload_hash','state','order_id','created_at'],
  groble_deliveries:['idempotency_key','event_id'],
  groble_refunds:['business_key','transaction_id','amount','partial_refund','refunded_at'],
};
const indexes = ['groble_events_pkey','groble_deliveries_pkey','groble_refunds_pkey','groble_events_transaction_idx','groble_refunds_transaction_idx'];
export async function inspectGrobleDatabase(client: SqlExecutor) {
  let phase = 'connection', open = false;
  const query = async <T>(sql: string, params: unknown[] = []) => (await client.query(sql,params)).rows as T[];
  try {
    const before = (await query<{role:string}>('select current_user as role'))[0]!.role;
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); open = true;
    const readOnly = (await query<{value:string}>("select current_setting('transaction_read_only') as value"))[0]!.value === 'on';
    if (!readOnly) throw new Error('Read-only transaction required');
    phase = 'migration_history';
    const historyExists = (await query<{present:boolean}>("select to_regclass('supabase_migrations.schema_migrations') is not null as present"))[0]!.present;
    const versions = historyExists ? await query<{version:string}>(
      'select version from supabase_migrations.schema_migrations where version=any($1::text[])',
      [['20261125000100','20261125000500']]) : [];
    const migrations = {inbox:versions.some(v=>v.version==='20261125000100'),timestamps:versions.some(v=>v.version==='20261125000500')};
    phase = 'schema';
    const relations = await query<{relname:string;relrowsecurity:boolean}>(`select relname,relrowsecurity from pg_class
      where relnamespace=to_regnamespace('private') and relkind='r' and relname=any($1::text[])`,[[...tables]]);
    const fields = await query<{table_name:string;column_name:string;is_nullable:string;data_type:string;column_default:string|null}>(
      `select table_name,column_name,is_nullable,data_type,column_default from information_schema.columns
       where table_schema='private' and table_name=any($1::text[])`,[[...tables]]);
    const schema = Object.fromEntries(tables.map(table=>[table,{
      present:relations.some(r=>r.relname===table),rls:relations.some(r=>r.relname===table&&r.relrowsecurity),
      columns:columns[table].every(c=>fields.some(f=>f.table_name===table&&f.column_name===c)),
    }]));
    const timestamp = fields.find(f=>f.table_name==='groble_events'&&f.column_name==='updated_at');
    const timestampColumn = timestamp?.is_nullable==='NO' && timestamp.data_type==='timestamp with time zone' && !!timestamp.column_default;
    const trigger = (await query<{present:boolean}>(`select exists(select 1 from pg_trigger t
      join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
      where n.nspname='private' and c.relname='groble_events' and t.tgname='groble_events_set_updated_at'
      and not t.tgisinternal and t.tgenabled in ('O','A') and pn.nspname='private' and p.proname='set_updated_at') as present`))[0]!.present;
    const foundIndexes = await query<{indexname:string}>("select indexname from pg_indexes where schemaname='private' and indexname=any($1::text[])",[indexes]);
    const indexesPresent = indexes.every(name=>foundIndexes.some(i=>i.indexname===name));
    phase = 'permissions';
    const roles = await query<{rolname:string}>("select rolname from pg_roles where rolname=any($1::text[])",[['anon','authenticated','service_role']]);
    const rolesPresent = roles.length===3;
    const allTables = tables.every(table=>schema[table]!.present);
    let browserAccessBlocked = false, servicePermissions = false;
    if (rolesPresent && allTables) {
      const access = await query<{table_name:string;browser_access:boolean;service_access:boolean}>(`select table_name,
        (has_table_privilege('anon','private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege('anon','private.'||table_name,'SELECT,INSERT,UPDATE,REFERENCES')
          or has_table_privilege('authenticated','private.'||table_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          or has_any_column_privilege('authenticated','private.'||table_name,'SELECT,INSERT,UPDATE,REFERENCES')) as browser_access,
        (has_schema_privilege('service_role','private','USAGE')
          and has_table_privilege('service_role','private.'||table_name,'SELECT')
          and has_table_privilege('service_role','private.'||table_name,'INSERT')
          and (table_name<>'groble_events' or has_table_privilege('service_role','private.'||table_name,'UPDATE'))) as service_access
        from unnest($1::text[]) as t(table_name)`,[[...tables]]);
      browserAccessBlocked = access.every(a=>!a.browser_access);
      servicePermissions = access.every(a=>a.service_access);
    }
    phase = 'service_role';
    await query('SET LOCAL ROLE service_role');
    const actual = (await query<{role:string;read_only:string}>("select current_user as role,current_setting('transaction_read_only') as read_only"))[0]!;
    const serviceRole = actual.role==='service_role' && actual.read_only==='on';
    phase = 'aggregate_counts';
    let counts: {total:number;pendingMapping:number;reviewRequired:number;applied:number} | null = null;
    if (allTables && schema.groble_events!.columns && servicePermissions) {
      const rows = await query<{state:string;count:string}>('select state,count(*)::text as count from private.groble_events group by state');
      const result = {total:0,pendingMapping:0,reviewRequired:0,applied:0};
      const keys = {pending_mapping:'pendingMapping',review_required:'reviewRequired',applied:'applied'} as const;
      for (const row of rows) {
        if (!Object.hasOwn(keys,row.state)) throw new Error('Unknown event state');
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count<0) throw new Error('Invalid aggregate');
        result[keys[row.state as keyof typeof keys]] += count; result.total += count;
      }
      if (!Number.isSafeInteger(result.total)) throw new Error('Invalid aggregate total');
      counts = result;
    }
    phase = 'rollback';
    await query('ROLLBACK'); open = false;
    const roleRestored = (await query<{role:string}>('select current_user as role'))[0]!.role===before;
    const databaseReady = migrations.inbox && migrations.timestamps && Object.values(schema).every(s=>s.present&&s.columns&&s.rls)
      && timestampColumn && trigger && indexesPresent && browserAccessBlocked && servicePermissions && serviceRole && roleRestored;
    return { scope:'database_only' as const, readOnly, databaseReady, paymentActivationChecked:false,
      migrations,schema,timestampColumn,timestampTriggerEnabled:trigger,indexesPresent,rolesPresent,
      browserAccessBlocked,servicePermissions,serviceRole,roleRestored,counts,
      attentionRequired:counts===null ? null : counts.pendingMapping>0||counts.reviewRequired>0,sharedDataWrites:0 };
  } catch (cause) {
    if (open) await client.query('ROLLBACK',[]).catch(()=>{});
    throw new GrobleReadinessError(phase,cause);
  }
}
