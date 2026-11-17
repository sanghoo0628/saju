import test from "node:test";
import assert from "node:assert/strict";
import {
  createSupabaseMessageSource,
  decodeInsertedMessage,
} from "../src/supabase-message-source.ts";
import {
  USER,
  PEER,
  ROOM,
  OTHER,
  message,
  clock,
  flush,
  deferred,
} from "./realtime-fixtures.ts";
import type { MessageSourceStatus } from "../src/message-source.ts";

type Client = Parameters<typeof createSupabaseMessageSource>[0];
const payload = (n = 1) => ({
  schema: "public",
  table: "messages",
  eventType: "INSERT",
  errors: null,
  new: {
    id: message(n).id,
    conversation_id: ROOM,
    sender_id: PEER,
    body: message(n).body,
    created_at: message(n).createdAt,
    private_extra: "never copy",
  },
});
function fake() {
  const channels: {
    name: string;
    options: unknown;
    filter?: unknown;
    event?: (data: unknown) => void;
    status?: (s: string) => void;
    on: Function;
    subscribe: Function;
  }[] = [];
  let authChange: ((event: string, session: unknown) => void) | undefined;
  let authUnsubscribes = 0,
    removes = 0;
  let user = USER;
  let get: () => Promise<unknown> = async () => ({
    data: { user: { id: user } },
    error: null,
  });
  const client = {
    auth: {
      getUser: () => get(),
      onAuthStateChange(callback: typeof authChange) {
        authChange = callback;
        return {
          data: {
            subscription: {
              unsubscribe() {
                authUnsubscribes++;
              },
            },
          },
        };
      },
    },
    channel(name: string, options: unknown) {
      const ch = {
        name,
        options,
        filter: undefined as unknown,
        event: undefined as ((v: unknown) => void) | undefined,
        status: undefined as ((s: string) => void) | undefined,
        on(_type: string, filter: unknown, callback: (v: unknown) => void) {
          ch.filter = filter;
          ch.event = callback;
          return ch;
        },
        subscribe(callback: (s: string) => void) {
          ch.status = callback;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    },
    removeChannel: async () => {
      removes++;
      return "ok";
    },
  } as unknown as Client;
  const c = clock(),
    statuses: MessageSourceStatus[] = [],
    messages: unknown[] = [];
  const source = createSupabaseMessageSource(client, { schedule: c.schedule });
  const subscribe = () =>
    source.subscribe({
      userId: USER,
      conversationId: ROOM,
      onStatus: (s) => statuses.push(s),
      onMessage: (m) => messages.push(m),
    });
  return {
    client,
    c,
    source,
    subscribe,
    channels,
    statuses,
    messages,
    auth(event: string, id: string | null) {
      user = id ?? USER;
      authChange?.(event, id ? { user: { id } } : null);
    },
    get stats() {
      return { removes, authUnsubscribes };
    },
    set get(value: typeof get) {
      get = value;
    },
  };
}

test("Supabase INSERT를 공개 ChatMessage 필드로만 변환한다", () => {
  assert.deepEqual(decodeInsertedMessage(payload(), ROOM), message(1));
  assert.deepEqual(
    decodeInsertedMessage({ ...payload(), errors: [] }, ROOM),
    message(1),
  );
});
test("다른 방·테이블·변경 종류·오류·잘못된 메시지는 수신하지 않는다", () => {
  for (const event of [
    null,
    {},
    { ...payload(), eventType: "DELETE" },
    { ...payload(), eventType: "UPDATE" },
    { ...payload(), schema: "private" },
    { ...payload(), table: "profile_saju" },
    { ...payload(), errors: ["not authorized"] },
    { ...payload(), new: { ...payload().new, conversation_id: OTHER } },
    { ...payload(), new: { ...payload().new, sender_id: "bad" } },
    { ...payload(), new: { ...payload().new, created_at: "yesterday" } },
    { ...payload(), new: { ...payload().new, body: " " } },
    { ...payload(), new: { ...payload().new, body: "x".repeat(2001) } },
  ])
    assert.equal(decodeInsertedMessage(event, ROOM), undefined);
});
test("현재 로그인 사용자를 확인한 뒤 해당 방 INSERT만 구독한다", async () => {
  const f = fake(),
    stop = f.subscribe();
  assert.equal(f.channels.length, 0);
  await flush();
  assert.equal(f.channels.length, 1);
  assert.deepEqual(f.channels[0]!.filter, {
    event: "INSERT",
    schema: "public",
    table: "messages",
    filter: `conversation_id=eq.${ROOM}`,
  });
  assert.deepEqual(f.channels[0]!.options, {
    config: { postgres_changes_options: { wait: true } },
  });
  f.channels[0]!.status!("SUBSCRIBED");
  f.channels[0]!.event!(payload());
  assert.deepEqual(f.statuses, ["connecting", "live"]);
  assert.deepEqual(f.messages, [message(1)]);
  stop();
  stop();
  assert.deepEqual(f.stats, { removes: 1, authUnsubscribes: 1 });
});
test("동일 방을 두 번 열어도 채널 이름이 달라 다른 구독을 해제하지 않는다", async () => {
  const f = fake();
  const a = f.subscribe(),
    b = f.subscribe();
  await flush();
  assert.notEqual(f.channels[0]!.name, f.channels[1]!.name);
  a();
  b();
});
test("로그인 사용자 불일치는 채널 생성 없이 거부한다", async () => {
  const f = fake();
  f.get = async () => ({ data: { user: { id: OTHER } }, error: null });
  f.subscribe();
  await flush();
  assert.equal(f.channels.length, 0);
  assert.equal(f.statuses.at(-1), "auth_required");
  assert.equal(f.stats.authUnsubscribes, 1);
  const immediate = fake();
  const register = immediate.client.auth.onAuthStateChange.bind(
    immediate.client.auth,
  );
  immediate.client.auth.onAuthStateChange = (callback) => {
    const result = register(callback);
    void callback("INITIAL_SESSION", null);
    return result;
  };
  immediate.subscribe();
  await flush();
  assert.equal(immediate.channels.length, 0);
  assert.equal(immediate.stats.authUnsubscribes, 1);
});
test("인증 요청 중 해제하면 늦은 사용자 응답이 채널을 열지 않는다", async () => {
  const response = deferred<unknown>(),
    f = fake();
  f.get = () => response.promise;
  const stop = f.subscribe();
  stop();
  response.resolve({ data: { user: { id: USER } }, error: null });
  await flush();
  assert.equal(f.channels.length, 0);
});
test("일시적 인증 통신 장애는 재시도하며 해제하면 타이머가 취소된다", async () => {
  const f = fake();
  let calls = 0;
  f.get = async () =>
    ++calls === 1
      ? { data: { user: null }, error: { status: 503 } }
      : { data: { user: { id: USER } }, error: null };
  const stop = f.subscribe();
  await flush();
  assert.equal(f.statuses.at(-1), "reconnecting");
  f.c.tick();
  await flush();
  assert.equal(f.channels.length, 1);
  stop();
  const second = fake();
  second.get = async () => {
    throw new TypeError("offline");
  };
  const cancel = second.subscribe();
  await flush();
  cancel();
  second.c.tick();
  await flush();
  assert.equal(second.channels.length, 0);
  assert.equal(second.c.jobs.filter((x) => x.active).length, 0);
});
test("로그아웃/계정 변경 뒤에는 기록 이벤트를 무시하고 구독을 정리한다", async () => {
  for (const id of [null, OTHER]) {
    const f = fake();
    f.subscribe();
    await flush();
    const old = f.channels[0]!;
    f.auth(id ? "SIGNED_IN" : "SIGNED_OUT", id);
    old.event!(payload());
    old.status!("SUBSCRIBED");
    await flush();
    assert.deepEqual(f.messages, []);
    assert.equal(f.statuses.at(-1), "auth_required");
    assert.deepEqual(f.stats, { removes: 1, authUnsubscribes: 1 });
  }
});
test("같은 계정의 토큰 갱신은 채널을 중복 생성하지 않는다", async () => {
  const f = fake();
  const stop = f.subscribe();
  await flush();
  f.auth("TOKEN_REFRESHED", USER);
  await flush();
  assert.equal(f.channels.length, 1);
  assert.equal(f.stats.removes, 0);
  stop();
});
test("오류·시간 초과를 알리고 닫힌 채널을 다시 만들며 오래된 콜백은 무시한다", async () => {
  const f = fake();
  const stop = f.subscribe();
  await flush();
  const old = f.channels[0]!;
  old.status!("CHANNEL_ERROR");
  old.status!("TIMED_OUT");
  assert.equal(f.statuses.at(-1), "reconnecting");
  old.status!("CLOSED");
  f.c.tick();
  await flush();
  assert.equal(f.channels.length, 2);
  old.event!(payload());
  assert.deepEqual(f.messages, []);
  f.channels[1]!.event!(payload());
  assert.deepEqual(f.messages, [message(1)]);
  stop();
});
test("유효하지 않은 ID로 필터를 만들지 않는다", () => {
  const f = fake();
  assert.throws(() =>
    f.source.subscribe({
      userId: USER,
      conversationId: "x,or=(id.eq.x)",
      onMessage: () => {},
      onStatus: () => {},
    }),
  );
  assert.equal(f.channels.length, 0);
});
