import type { ChatProfile } from '../../packages/payment-chat-ui/src/types';
import { schedule, type Schedule } from '../../packages/payment-chat/src/message-source';

export interface ChatProfileLookup { profiles: ChatProfile[]; failed: boolean }
export type ChatProfileReader = (ids: string[], signal: AbortSignal) => PromiseLike<{ data: unknown; error: unknown }>;

/** Browser RLS reader only. Names/majors are optional presentation data, never chat permission. */
export async function loadChatProfiles(ids: readonly string[], read: ChatProfileReader, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  schedule?: Schedule;
} = {}): Promise<ChatProfileLookup> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid profile lookup deadline');
  const unique = [...new Set(ids)];
  if (!unique.length) return { profiles: [], failed: false };
  const batches = Array.from({ length: Math.ceil(unique.length / 50) }, (_, index) => unique.slice(index * 50, (index + 1) * 50));
  const controller = new AbortController();
  const parentAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', parentAbort, { once: true });
  let removeAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', abort);
  });
  const cancelTimeout = (options.schedule ?? schedule)(() => controller.abort(new DOMException('Profile lookup timeout', 'TimeoutError')), timeoutMs);
  const profiles = new Map<string, ChatProfile>();
  let index = 0, failed = false, finished = false;
  async function worker() {
    while (!finished && !controller.signal.aborted && index < batches.length) {
      const batch = batches[index++]!;
      try {
        const result = await read([...batch], controller.signal);
        if (finished || controller.signal.aborted) return;
        if (result.error || !Array.isArray(result.data)) { failed = true; continue; }
        for (const value of result.data) {
          const row = value as Record<string, unknown> | null;
          if (!row || typeof row.id !== 'string' || !batch.includes(row.id) || typeof row.nickname !== 'string'
            || !row.nickname.trim() || !(row.major === null || typeof row.major === 'string')) {
            failed = true; continue;
          }
          profiles.set(row.id, { userId: row.id, nickname: row.nickname, major: row.major });
        }
      } catch { if (!finished && !controller.signal.aborted) failed = true; }
    }
  }
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(4, batches.length) }, worker)), aborted]);
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    failed = true;
  } finally {
    finished = true;
    cancelTimeout();
    removeAbort();
    options.signal?.removeEventListener('abort', parentAbort);
    controller.abort();
  }
  return { profiles: unique.flatMap(id => profiles.has(id) ? [{ ...profiles.get(id)! }] : []), failed };
}
