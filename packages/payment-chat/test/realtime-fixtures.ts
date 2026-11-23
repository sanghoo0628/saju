import type { MessageSource, Schedule } from "../src/message-source.ts";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";
export const USER = "00000000-0000-4000-8000-000000000001";
export const PEER = "00000000-0000-4000-8000-000000000002";
export const ROOM = "00000000-0000-4000-8000-000000000010";
export const OTHER = "00000000-0000-4000-8000-000000000099";
export const message = (n: number): ChatMessage => ({
  id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
  conversationId: ROOM,
  senderId: PEER,
  body: `인사 ${n}`,
  createdAt: new Date(1800000000000 + n * 1000).toISOString(),
});
export function clock() {
  const jobs: { run: () => void; active: boolean; delay: number }[] = [];
  const schedule: Schedule = (run, delay) => {
    const job = { run, active: true, delay };
    jobs.push(job);
    return () => {
      job.active = false;
    };
  };
  return {
    schedule,
    jobs,
    tick() {
      const job = jobs.find((x) => x.active);
      if (job) {
        job.active = false;
        job.run();
      }
    },
  };
}
export function source() {
  let callbacks: Parameters<MessageSource["subscribe"]>[0] | undefined;
  let stops = 0;
  const source: MessageSource = {
    subscribe(options) {
      callbacks = options;
      return () => {
        stops++;
      };
    },
  };
  return {
    source,
    get callbacks() {
      return callbacks!;
    },
    get stops() {
      return stops;
    },
  };
}
export async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
