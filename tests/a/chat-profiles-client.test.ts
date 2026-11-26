import test from 'node:test';
import assert from 'node:assert/strict';
import { loadChatProfiles } from '../../src/lib/chat-profiles-client';
import { clock, deferred, flush } from '../../packages/payment-chat/test/realtime-fixtures';

const row = (id: string) => ({ id, nickname: `name-${id}`, major: null });
const ids = (count: number) => Array.from({ length: count }, (_, i) => `user-${i}`);

test('deduplicates IDs, batches reads and copies only the permitted public fields', async () => {
  const batches: string[][] = [];
  const result = await loadChatProfiles([...ids(51), 'user-1'], async batch => {
    batches.push(batch);
    return { data: batch.map(id => ({ ...row(id), email: 'private-marker', birth_date: 'private-marker' })), error: null };
  });
  assert.deepEqual(batches.map(batch => batch.length), [50, 1]);
  assert.equal(result.failed, false); assert.equal(result.profiles.length, 51);
  assert.deepEqual(result.profiles[0], { userId: 'user-0', nickname: 'name-user-0', major: null });
  assert.ok(!JSON.stringify(result).includes('private-marker'));
});

test('partial failures keep successful rows and a separate retry restores names without changing IDs', async () => {
  const users = ids(51);
  const partial = await loadChatProfiles(users, async batch => batch.length === 1
    ? { data: null, error: new Error('private-api-detail') }
    : { data: batch.map(row), error: null });
  assert.equal(partial.profiles.length, 50); assert.equal(partial.failed, true);
  assert.ok(!JSON.stringify(partial).includes('private-api-detail'));
  const retried = await loadChatProfiles(users, async batch => ({ data: batch.map(row), error: null }));
  assert.equal(retried.failed, false); assert.equal(retried.profiles.length, 51);
});

test('a deadline settles even when the SDK ignores cancellation; late rows cannot mutate the result', async () => {
  const timer = clock(), late = deferred<{ data: unknown; error: unknown }>();
  let signal: AbortSignal | undefined, reads = 0;
  const lookup = loadChatProfiles(['user-1'], async (_batch, current) => { signal = current; reads++; return late.promise; }, { schedule: timer.schedule });
  timer.tick();
  const result = await lookup;
  assert.deepEqual(result, { profiles: [], failed: true }); assert.equal(signal?.aborted, true);
  late.resolve({ data: [row('user-1')], error: null }); await flush();
  assert.deepEqual(result, { profiles: [], failed: true }); assert.equal(reads, 1);
  assert.equal(timer.jobs.filter(job => job.active).length, 0);
});

test('navigation cancellation aborts SDK work and rejects without publishing an old lookup', async () => {
  const parent = new AbortController(), timer = clock(); let signal: AbortSignal | undefined;
  const lookup = loadChatProfiles(['old-peer'], async (_batch, current) => { signal = current; return new Promise(() => {}); }, { signal: parent.signal, schedule: timer.schedule });
  parent.abort();
  await assert.rejects(lookup, error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(signal?.aborted, true); assert.equal(timer.jobs.filter(job => job.active).length, 0);
  let reads = 0;
  await assert.rejects(loadChatProfiles(['new-peer'], async () => { reads++; return { data: [], error: null }; }, { signal: parent.signal }));
  assert.equal(reads, 0);
});

test('large inboxes use at most four concurrent lookups instead of unbounded fanout', async () => {
  let active = 0, maxActive = 0;
  const pending: { batch: string[]; done: ReturnType<typeof deferred<void>> }[] = [];
  const lookup = loadChatProfiles(ids(251), async batch => {
    active++; maxActive = Math.max(maxActive, active);
    const done = deferred<void>(); pending.push({ batch, done });
    await done.promise; active--;
    return { data: batch.map(row), error: null };
  });
  assert.equal(pending.length, 4);
  for (let i = 0; i < 3; i++) {
    const current = pending.splice(0); for (const job of current) job.done.resolve();
    await flush();
  }
  const result = await lookup;
  assert.equal(result.failed, false); assert.equal(result.profiles.length, 251); assert.equal(maxActive, 4);
});

test('hidden/deleted profiles remain absent; foreign and malformed rows are not exposed', async () => {
  assert.deepEqual(await loadChatProfiles(['hidden-peer'], async () => ({ data: [], error: null })), { profiles: [], failed: false });
  const result = await loadChatProfiles(['known-peer'], async () => ({ data: [row('other-peer'), { ...row('known-peer'), nickname: ' ' }, null], error: null }));
  assert.deepEqual(result, { profiles: [], failed: true });
});

test('empty selections do not query and invalid deadlines cannot start requests', async () => {
  let calls = 0;
  const read = async () => { calls++; return { data: [], error: null }; };
  assert.deepEqual(await loadChatProfiles([], read), { profiles: [], failed: false });
  for (const timeoutMs of [0, -1, Infinity, 120001]) await assert.rejects(loadChatProfiles(['peer'], read, { timeoutMs }));
  assert.equal(calls, 0);
});
