import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createDeadlinePool, PostgresDeadlineError } from '../src/server/postgres-deadline';
import { createPostgresUnitOfWork } from '../src/server/postgres-repository';
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
function client(query = vi.fn<(sql: string) => Promise<{rows: never[]}>>(async () => ({rows:[]}))) {
  return {query,release:vi.fn()} as unknown as PoolClient;
}
beforeEach(()=>vi.useFakeTimers({toFake:['setTimeout','clearTimeout','performance']}));
afterEach(()=>vi.useRealTimers());
it('uses the same absolute deadline across checkout and successive queries',async()=>{
  const c=client(),p=createDeadlinePool({connect:async()=>c},100);
  const checked=await p.connect();await vi.advanceTimersByTimeAsync(80);
  await checked.query('select 1');await vi.advanceTimersByTimeAsync(21);
  await expect(checked.query('select 2')).rejects.toBeInstanceOf(PostgresDeadlineError);
  expect(c.query).toHaveBeenCalledTimes(1);expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});
it('timed-out checkout returns an error and destroys a client that arrives late',async()=>{
  const late=deferred<PoolClient>(),c=client(),pool=createDeadlinePool({connect:()=>late.promise},50);
  const outcome=pool.connect().catch(error=>error);
  await vi.advanceTimersByTimeAsync(51);expect(await outcome).toBeInstanceOf(PostgresDeadlineError);
  late.resolve(c);await vi.advanceTimersByTimeAsync(0);
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});
it('timed-out query destroys the active connection and suppresses a late success',async()=>{
  const pending=deferred<{rows:never[]}>(),c=client(vi.fn(()=>pending.promise));
  const checked=await createDeadlinePool({connect:async()=>c},50).connect();
  const outcome=checked.query('select pg_sleep(1)').catch(error=>error);
  await vi.advanceTimersByTimeAsync(51);expect(await outcome).toBeInstanceOf(PostgresDeadlineError);
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  pending.resolve({rows:[]});await vi.advanceTimersByTimeAsync(0);
  checked.release(true);expect(c.release).toHaveBeenCalledTimes(1);
});
it('a normal checkout/query/release preserves results and does not double-release',async()=>{
  const c=client(),checked=await createDeadlinePool({connect:async()=>c},50).connect();
  expect(await checked.query('select 1')).toEqual({rows:[]});checked.release(false);checked.release(true);
  expect(c.release).toHaveBeenCalledExactlyOnceWith(false);expect(vi.getTimerCount()).toBe(0);
});
it('query failures preserve the original error and clear timers',async()=>{
  const failure=Object.assign(new Error('fixture'),{code:'23503'});
  const c=client(vi.fn(async()=>{throw failure;})),checked=await createDeadlinePool({connect:async()=>c},50).connect();
  await expect(checked.query('bad')).rejects.toBe(failure);expect(vi.getTimerCount()).toBe(0);
  checked.release(true);
});
it('does not acquire another connection after the retry budget has expired',async()=>{
  const c=client(),connect=vi.fn(async()=>c),pool=createDeadlinePool({connect},50);
  const checked=await pool.connect();checked.release(false);await vi.advanceTimersByTimeAsync(51);
  await expect(pool.connect()).rejects.toBeInstanceOf(PostgresDeadlineError);expect(connect).toHaveBeenCalledTimes(1);
});
it('timeout during COMMIT is never replayed or reported as successful',async()=>{
  const pending=deferred<{rows:never[]}>();
  const c=client(vi.fn(sql=>sql==='COMMIT'?pending.promise:Promise.resolve({rows:[]})));
  const connect=vi.fn(async()=>c),run=vi.fn(async()=> 'committed');
  const database=createPostgresUnitOfWork(createDeadlinePool({connect},50),q=>q,{retryDelayMs:0});
  const outcome=database.transaction(run).catch(error=>error);
  await vi.advanceTimersByTimeAsync(51);
  expect(await outcome).toBeInstanceOf(PostgresDeadlineError);
  expect(connect).toHaveBeenCalledTimes(1);expect(run).toHaveBeenCalledTimes(1);
  expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
  pending.resolve({rows:[]});await vi.advanceTimersByTimeAsync(0);
});
it('deadline runs out even when many short queries individually succeed',async()=>{
  const c=client();const db=createPostgresUnitOfWork(createDeadlinePool({connect:async()=>c},50),q=>q);
  const outcome=db.transaction(async q=>{
    await q.query('select 1',[]);await vi.advanceTimersByTimeAsync(51);await q.query('select 2',[]);
  }).catch(error=>error);
  expect(await outcome).toBeInstanceOf(PostgresDeadlineError);
  expect(c.query).not.toHaveBeenCalledWith('COMMIT');expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
});
it.each([0,-1,6501,1.5,Infinity])('rejects invalid budget %s',value=>{
  expect(()=>createDeadlinePool({connect:async()=>client()},value)).toThrow('Invalid webhook database budget');
});

it('does not start queued checkout work after the monotonic budget has elapsed',async()=>{
  const clock=vi.spyOn(performance,'now').mockReturnValue(0);
  try {
    const connect=vi.fn(async()=>client()),pool=createDeadlinePool({connect},50);
    const outcome=pool.connect().catch(error=>error);
    clock.mockReturnValue(100);
    expect(await outcome).toBeInstanceOf(PostgresDeadlineError);
    expect(connect).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  } finally {clock.mockRestore();}
});
