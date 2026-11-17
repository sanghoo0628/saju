import test from "node:test";
import assert from "node:assert/strict";
import { createMessageSession } from "../src/message-session.ts";
import { PaymentChatClientError } from "../src/client.ts";
import {
  USER,
  PEER,
  ROOM,
  OTHER,
  message,
  clock,
  source,
  flush,
  deferred,
} from "./realtime-fixtures.ts";
import type { ChatMessage } from "../../../contracts/payment-chat.ts";
const room = {
  id: ROOM,
  members: [USER, PEER] as [string, string],
  createdAt: message(1).createdAt,
};
function setup(
  read: (
    room: string,
    after?: string,
    signal?: AbortSignal,
  ) => Promise<ChatMessage[]> = async () => [],
) {
  const stream = source(),
    c = clock();
  let reads = 0;
  const session = createMessageSession({
    userId: USER,
    conversation: room,
    source: stream.source,
    schedule: c.schedule,
    client: {
      messages: async (...args) => {
        reads++;
        return read(...args);
      },
    },
  });
  return {
    stream,
    c,
    session,
    get reads() {
      return reads;
    },
  };
}

test("첫 HTTP 권한 확인 전에는 이벤트를 표시하지 않고 성공 후 기록과 합친다", async () => {
  const pending = deferred<ChatMessage[]>(),
    f = setup(() => pending.promise);
  f.session.start();
  f.stream.callbacks.onMessage(message(2));
  assert.deepEqual(f.session.snapshot().messages, []);
  pending.resolve([message(1)]);
  await flush();
  assert.deepEqual(f.session.snapshot().messages, [message(1), message(2)]);
  f.session.dispose();
});
test("HTTP 권한 오류가 나면 초기 이벤트를 버리고 자동 조회와 구독을 중단한다", async () => {
  const f = setup(async () => {
    throw new PaymentChatClientError("FORBIDDEN", "blocked", 403);
  });
  f.session.start();
  f.stream.callbacks.onMessage(message(1));
  await flush();
  assert.deepEqual(f.session.snapshot().messages, []);
  assert.ok(f.session.snapshot().accessError);
  assert.equal(f.stream.stops, 1);
  assert.equal(f.c.jobs.filter((x) => x.active).length, 0);
  f.stream.callbacks.onMessage(message(2));
  assert.deepEqual(f.session.snapshot().messages, []);
  f.session.dispose();
});
test("전송 응답·실시간 수신·HTTP 기록이 겹쳐도 하나만 표시한다", async () => {
  const f = setup(async (_room, after) => (after ? [] : [message(1)]));
  f.session.start();
  await flush();
  f.session.receive(message(1));
  f.stream.callbacks.onMessage(message(1));
  await f.session.refresh();
  assert.deepEqual(f.session.snapshot().messages, [message(1)]);
  f.session.dispose();
});
test("다른 방과 참여자가 아닌 작성자의 이벤트·잘못된 데이터는 무시한다", async () => {
  const f = setup();
  f.session.start();
  await flush();
  for (const m of [
    { ...message(1), conversationId: OTHER },
    { ...message(1), senderId: OTHER },
    { ...message(1), body: "" },
    { ...message(1), createdAt: "bad" },
  ])
    assert.equal(f.session.receive(m), false);
  assert.deepEqual(f.session.snapshot().messages, []);
  f.session.dispose();
});
test("버퍼에 보관한 이벤트를 외부에서 수정해도 표시 내용은 바뀌지 않는다", async () => {
  const pending = deferred<ChatMessage[]>(),
    f = setup(() => pending.promise);
  f.session.start();
  const m = message(1);
  f.stream.callbacks.onMessage(m);
  m.body = "changed";
  pending.resolve([]);
  await flush();
  assert.equal(f.session.snapshot().messages[0]!.body, message(1).body);
  f.session.dispose();
});
test("연결 재수립 시 처음부터 조회하여 끊긴 동안의 누락을 복구한다", async () => {
  const cursors: (string | undefined)[] = [];
  let rows = [message(1)];
  const f = setup(async (_room, after) => {
    cursors.push(after);
    return rows;
  });
  f.session.start();
  await flush();
  f.stream.callbacks.onStatus("reconnecting");
  rows = [message(1), message(2)];
  f.stream.callbacks.onStatus("live");
  await flush();
  assert.equal(cursors.at(-1), undefined);
  assert.deepEqual(f.session.snapshot().messages, rows);
  assert.equal(f.session.snapshot().connection, "live");
  f.session.dispose();
});
test("초기 조회 중 연결 확정이 와도 오래된 페이지를 버리고 다시 조회한다", async () => {
  const pending = deferred<ChatMessage[]>();
  let calls = 0;
  const f = setup(async () => (++calls === 1 ? pending.promise : [message(2)]));
  f.session.start();
  await flush();
  f.stream.callbacks.onStatus("live");
  pending.resolve([message(1)]);
  await flush();
  assert.deepEqual(f.session.snapshot().messages, [message(2)]);
  assert.equal(calls, 2);
  f.session.dispose();
});
test("Realtime이 살아 있어도 HTTP 조회로 차단을 확인하고 이전 기록을 지운다", async () => {
  let blocked = false;
  const f = setup(async (_room, after) => {
    if (blocked) throw new PaymentChatClientError("BLOCKED", "blocked", 403);
    return after ? [] : [message(1)];
  });
  f.session.start();
  await flush();
  f.stream.callbacks.onStatus("live");
  await flush();
  blocked = true;
  f.c.tick();
  await flush();
  assert.deepEqual(f.session.snapshot().messages, []);
  assert.equal(f.session.snapshot().connection, "auth_required");
  assert.equal(f.stream.stops, 1);
  f.session.dispose();
});
test("서버 요청이 실패하면 기록을 유지하고 다음 HTTP 조회로 복구한다", async () => {
  let offline = false;
  const f = setup(async (_room, after) => {
    if (offline) throw new TypeError("offline");
    return after ? [] : [message(1)];
  });
  f.session.start();
  await flush();
  offline = true;
  await f.session.refresh();
  assert.ok(f.session.snapshot().historyError);
  assert.deepEqual(f.session.snapshot().messages, [message(1)]);
  offline = false;
  f.c.tick();
  await flush();
  assert.equal(f.session.snapshot().historyError, "");
  f.session.dispose();
});
test("Auth 만료 이벤트는 HTTP 응답을 기다리지 않고 기록을 지운다", async () => {
  const f = setup(async (_room, after) => (after ? [] : [message(1)]));
  f.session.start();
  await flush();
  f.stream.callbacks.onStatus("auth_required");
  assert.deepEqual(f.session.snapshot().messages, []);
  assert.ok(f.session.snapshot().accessError);
  f.session.dispose();
});
test("화면 해제 후 늦은 HTTP·Realtime·상태 이벤트가 화면을 갱신하지 않는다", async () => {
  const pending = deferred<ChatMessage[]>(),
    f = setup(() => pending.promise);
  let updates = 0;
  f.session.subscribe(() => updates++);
  f.session.start();
  await flush();
  f.session.dispose();
  const before = updates;
  pending.resolve([message(1)]);
  f.stream.callbacks.onMessage(message(2));
  f.stream.callbacks.onStatus("live");
  await flush();
  assert.equal(updates, before);
  assert.deepEqual(f.session.snapshot().messages, []);
  assert.equal(f.stream.stops, 1);
});
test("100개 페이지 뒤에도 Realtime의 최신 ID를 HTTP 커서로 사용하지 않는다", async () => {
  const cursors: (string | undefined)[] = [];
  const first = Array.from({ length: 100 }, (_, i) => message(i + 1));
  const f = setup(async (_room, after) => {
    cursors.push(after);
    return after ? [] : first;
  });
  f.session.start();
  f.stream.callbacks.onMessage(message(300));
  await flush();
  assert.deepEqual(cursors, [undefined, message(100).id]);
  assert.equal(f.session.snapshot().messages.length, 101);
  f.session.dispose();
});
test("source가 없거나 구독 생성이 실패해도 HTTP 조회를 유지한다", async () => {
  const c = clock();
  let reads = 0;
  const s = createMessageSession({
    userId: USER,
    conversation: room,
    schedule: c.schedule,
    client: {
      messages: async (_room, after) => {
        reads++;
        return after ? [] : [message(1)];
      },
    },
  });
  s.start();
  await flush();
  assert.equal(s.snapshot().connection, "polling");
  c.tick();
  await flush();
  assert.equal(reads, 2);
  s.dispose();
  const broken = createMessageSession({
    userId: USER,
    conversation: room,
    schedule: c.schedule,
    client: { messages: async () => [message(1)] },
    source: {
      subscribe() {
        throw new Error();
      },
    },
  });
  broken.start();
  await flush();
  assert.equal(broken.snapshot().connection, "reconnecting");
  assert.deepEqual(broken.snapshot().messages, [message(1)]);
  broken.dispose();
});
test("해제 콜백 오류가 있어도 차단된 대화의 보관 기록을 지운다", async () => {
  const c = clock();
  const s = createMessageSession({
    userId: USER,
    conversation: room,
    schedule: c.schedule,
    client: { messages: async () => [message(1)] },
    source: {
      subscribe() {
        return () => {
          throw new Error("cleanup");
        };
      },
    },
  });
  s.start();
  await flush();
  assert.doesNotThrow(() =>
    s.deny(new PaymentChatClientError("BLOCKED", "blocked", 403)),
  );
  assert.deepEqual(s.snapshot().messages, []);
  s.dispose();
});

test("초기 수신 버퍼가 제한을 넘겨도 이후 HTTP 기록 조회로 누락을 복구한다", async () => {
  const first = deferred<ChatMessage[]>();
  let calls = 0;
  const rows = Array.from({ length: 201 }, (_, i) => message(i + 1));
  const f = setup(async (_room, after) => {
    if (++calls === 1) return first.promise;
    const index = after ? rows.findIndex((m) => m.id === after) : -1;
    return rows.slice(index + 1, index + 101);
  });
  f.session.start();
  await flush();
  for (const m of rows) f.stream.callbacks.onMessage(m);
  first.resolve([]);
  await flush();
  assert.equal(f.session.snapshot().messages.length, 200);
  f.c.tick();
  await flush();
  assert.equal(f.session.snapshot().messages.length, 201);
  f.session.dispose();
});
