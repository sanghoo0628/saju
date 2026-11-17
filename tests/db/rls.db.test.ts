/**
 * 접근 권한과 C 계약 제약 검증 (개발 계획 3·5·8장 + 2026-11-16 기획 변경)
 * - 추천 프로필 3명은 결제 없이 열람
 * - 주문은 "구매자 → 본인이 추천받은 상대 1명"
 * - 제3자는 프로필·주문·채팅 기록에 접근하지 못하고, 차단은 양방향으로 반영
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createOrder, createTestDb, recommend, seedUsers, uid, type Recommendation, type TestDb } from "./harness";

const ME = uid(1);
const M1 = uid(10);
const M2 = uid(11);
const M3 = uid(12);
const OTHER = uid(13); // 4위라 추천되지 않음
const STRANGER = uid(99);

let t: TestDb;
let recs: Recommendation[];
const recFor = (target: string) => recs.find((r) => r.target_id === target)!;

const ids = (rows: { user_id: string }[]) => rows.map((r) => r.user_id).sort();
const visibleProfiles = (user: string | null) =>
  t.asUser(user, (q) => q.query<{ user_id: string }>(`select id as user_id from public.profiles`)).then((r) => ids(r.rows));
const rowsAs = (user: string, sql: string) => t.asUser(user, (q) => q.query(sql)).then((r) => r.rows);

beforeEach(async () => {
  t = await createTestDb();
  await seedUsers(t.db, [
    { id: ME, score: 3500, photoPath: `${ME}/me.jpg` },
    { id: M1, score: -3490, photoPath: `${M1}/a.jpg` },
    { id: M2, score: -3530 },
    { id: M3, score: -3600 },
    { id: OTHER, score: -2900, photoPath: `${OTHER}/b.jpg` },
    { id: STRANGER, score: 100 },
  ]);
  recs = await recommend(t, ME);
});

describe("프로필 공개 범위 (결제 불필요)", () => {
  it("추천받은 사용자는 결제 없이 본인 + 추천 3명을 본다", async () => {
    expect(await visibleProfiles(ME)).toEqual([ME, M1, M2, M3].sort());
    expect(await rowsAs(ME, `select * from public.orders`)).toEqual([]);
  });

  it("추천받지 않은 제3자·비로그인은 다른 사람 프로필을 보지 못한다", async () => {
    expect(await visibleProfiles(OTHER)).toEqual([OTHER]);
    await expect(visibleProfiles(null)).rejects.toThrow(/permission denied/);
  });

  it("추천 결과는 본인만 조회한다", async () => {
    expect(await rowsAs(ME, `select id,user_id,target_id,rank,created_at from public.match_results`)).toHaveLength(3);
    expect(await rowsAs(M1, `select id,user_id,target_id,rank,created_at from public.match_results`)).toEqual([]);
  });

  it("상대가 공개 동의를 철회하면 숨겨진다", async () => {
    await t.asUser(M1, (q) => q.query(`update public.profiles set is_public = false where id = $1`, [M1]));
    expect(await visibleProfiles(ME)).toEqual([ME, M2, M3].sort());
  });

  it("어느 쪽이 차단하든 숨겨진다", async () => {
    await t.asUser(M2, (q) => q.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [M2, ME]));
    await t.asUser(ME, (q) => q.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [ME, M3]));
    expect(await visibleProfiles(ME)).toEqual([ME, M1].sort());
    expect(await visibleProfiles(M2)).toEqual([M2]);
  });
});

describe("비공개 정보와 쓰기 권한", () => {
  it("생년월일·사주는 본인 것만", async () => {
    for (const table of ["private_birth_data", "fortune_results"]) {
      expect(ids((await rowsAs(ME, `select user_id from public.${table}`)) as { user_id: string }[])).toEqual([ME]);
    }
  });

  it("사용자는 점수·추천·주문을 직접 쓸 수 없다", async () => {
    await expect(rowsAs(ME, `update public.fortune_results set score = -1`)).rejects.toThrow(/permission denied/);
    await expect(rowsAs(ME, `delete from public.match_results`)).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(ME, (q) => q.query(
        `insert into public.orders (buyer_id, target_id, match_result_id, status) values ($1, $2, $3, 'fulfilled')`,
        [ME, M1, recFor(M1).id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("프로필 수정", () => {
  it("본인 닉네임·공개 동의는 수정할 수 있고 동의 시각이 기록된다", async () => {
    await t.db.query(`update public.profiles set is_public = false, public_consented_at = null where id = $1`, [STRANGER]);
    await t.asUser(STRANGER, (q) =>
      q.query(`update public.profiles set nickname = '새이름', is_public = true where id = $1`, [STRANGER]));
    const r = await t.db.query<{ nickname: string; public_consented_at: Date | null }>(
      `select nickname, public_consented_at from public.profiles where id = $1`, [STRANGER]);
    expect(r.rows[0]!.nickname).toBe("새이름");
    expect(r.rows[0]!.public_consented_at).not.toBeNull();
  });

  it("계열·활성 상태는 직접 바꿀 수 없다", async () => {
    await expect(rowsAs(ME, `update public.profiles set track = 'science'`)).rejects.toThrow(/permission denied/);
    await expect(rowsAs(ME, `update public.profiles set status = 'active'`)).rejects.toThrow(/permission denied/);
  });

  it("다른 사람 프로필은 수정되지 않고, 사진 경로는 본인 폴더만", async () => {
    const r = await t.asUser(ME, (q) => q.query(`update public.profiles set nickname = 'x' where id = $1`, [M1]));
    expect(r.affectedRows).toBe(0);
    await expect(
      t.asUser(ME, (q) => q.query(`update public.profiles set photo_path = $1 where id = $2`, [`${M1}/a.jpg`, ME])),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("상대별 주문·결제 (C 계약 제약)", () => {
  it("주문은 본인이 추천받은 상대에게만 만들 수 있다", async () => {
    await createOrder(t, ME, recFor(M1));
    // 남의 추천 결과 ID 로 주문
    await expect(createOrder(t, STRANGER, recFor(M2))).rejects.toThrow(/orders_match_result_fk/);
    // 추천 결과와 다른 상대로 주문
    await expect(createOrder(t, ME, { id: recFor(M2).id, target_id: OTHER })).rejects.toThrow(/orders_match_result_fk/);
  });

  it("같은 구매자-상대의 활성 주문은 하나뿐 (취소 후에는 새로 가능)", async () => {
    const first = await createOrder(t, ME, recFor(M1));
    await expect(createOrder(t, ME, recFor(M1))).rejects.toThrow(/orders_active_pair_uniq/);
    await createOrder(t, ME, recFor(M2)); // 다른 상대는 별도 주문
    await t.db.query(`update public.orders set status = 'cancelled' where id = $1`, [first.id]);
    await createOrder(t, ME, recFor(M1));
  });

  it("금액은 500원으로 고정된다", async () => {
    await expect(
      t.db.query(`insert into public.orders (buyer_id, target_id, match_result_id, amount) values ($1, $2, $3, 100)`,
        [ME, M1, recFor(M1).id]),
    ).rejects.toThrow(/check constraint/);
  });

  it("거래 ID 하나는 주문 하나에만, 주문 하나에는 결제 하나만", async () => {
    const o1 = await createOrder(t, ME, recFor(M1));
    const o2 = await createOrder(t, ME, recFor(M2));
    await t.db.query(`insert into public.payments (transaction_id, order_id, amount) values ('tx-1', $1, 500)`, [o1.id]);
    await expect(
      t.db.query(`insert into public.payments (transaction_id, order_id, amount) values ('tx-1', $1, 500)`, [o2.id]),
    ).rejects.toThrow(/payments_pkey/);
    await expect(
      t.db.query(`insert into public.payments (transaction_id, order_id, amount) values ('tx-2', $1, 500)`, [o1.id]),
    ).rejects.toThrow(/payments_order_id_key/);
  });

  it("주문은 구매자만 조회하고, 결제 기록은 브라우저에 노출하지 않는다", async () => {
    await createOrder(t, ME, recFor(M1));
    expect(await rowsAs(ME, `select * from public.orders`)).toHaveLength(1);
    expect(await rowsAs(M1, `select * from public.orders`)).toEqual([]);
    await expect(rowsAs(ME, `select * from public.payments`)).rejects.toThrow(/permission denied/);
  });
});

describe("프로필 사진 (Storage)", () => {
  beforeEach(async () => {
    for (const name of [`${ME}/me.jpg`, `${M1}/a.jpg`, `${OTHER}/b.jpg`]) {
      await t.db.query(`insert into storage.objects (bucket_id, name) values ('profile-photos', $1)`, [name]);
    }
  });

  const visiblePhotos = (user: string) =>
    t.asUser(user, (q) => q.query<{ name: string }>(`select name from storage.objects order by name`)).then((r) => r.rows.map((x) => x.name));

  it("사진 URL 로도 권한이 우회되지 않는다", async () => {
    expect(await visiblePhotos(ME)).toEqual([`${ME}/me.jpg`, `${M1}/a.jpg`].sort());
    expect(await visiblePhotos(STRANGER)).toEqual([]);
  });

  it("다른 사람 폴더에는 업로드할 수 없다", async () => {
    await expect(
      t.asUser(ME, (q) => q.query(`insert into storage.objects (bucket_id, name) values ('profile-photos', $1)`, [`${M1}/x.jpg`])),
    ).rejects.toThrow(/row-level security/);
    await t.asUser(ME, (q) =>
      q.query(`insert into storage.objects (bucket_id, name) values ('profile-photos', $1)`, [`${ME}/new.jpg`]));
  });
});

describe("대화 요청과 채팅", () => {
  let orderId: string;
  let convId: string;
  let messageSequence: number;

  // C 의 서버 API 가 하는 일: 결제 완료 → 요청 → 수락 → 채팅방
  beforeEach(async () => {
    messageSequence = 0;
    orderId = (await createOrder(t, ME, recFor(M1), "fulfilled")).id;
    await t.asService((q) =>
      q.query(`insert into public.chat_requests (requester_id, recipient_id, order_id) values ($1, $2, $3)`, [ME, M1, orderId]));
  });

  const openConversation = async () => {
    const [a, b] = [ME, M1].sort();
    const r = await t.asService(async (q) => {
      await q.query(`update public.chat_requests set status = 'accepted', responded_at = now() where requester_id = $1`, [ME]);
      return q.query<{ id: string }>(`insert into public.conversations (user_a, user_b) values ($1, $2) returning id`, [a, b]);
    });
    convId = r.rows[0]!.id;
  };
  const serverSend = (sender: string, body: string) =>
    // 동일 시각의 UUID 순서를 삽입 순서로 가정하지 않도록 테스트 시각을 명시한다.
    t.asService((q) => q.query(`insert into public.messages (conversation_id, sender_id, body, created_at) values ($1, $2, $3, $4)`,
      [convId, sender, body, new Date(Date.UTC(2026, 10, 17, 0, 0, ++messageSequence))]));
  const read = (u: string) =>
    t.asUser(u, (q) => q.query<{ body: string }>(`select body from public.messages order by created_at, id`)).then((r) => r.rows.map((m) => m.body));

  it("요청을 받은 사람은 요청자 프로필을 볼 수 있다 (M1 은 ME 를 추천받지 않았어도)", async () => {
    expect(await visibleProfiles(M1)).toEqual([ME, M1].sort());
    expect(await rowsAs(M1, `select * from public.chat_requests`)).toHaveLength(1);
    expect(await rowsAs(STRANGER, `select * from public.chat_requests`)).toEqual([]);
  });

  it("같은 상대에게 중복 요청할 수 없다", async () => {
    await expect(
      t.asService((q) => q.query(`insert into public.chat_requests (requester_id, recipient_id, order_id) values ($1, $2, $3)`, [ME, M1, orderId])),
    ).rejects.toThrow(/unique/);
  });

  it("두 사람의 채팅방은 순서와 무관하게 하나뿐", async () => {
    await openConversation();
    const [a, b] = [ME, M1].sort();
    await expect(t.db.query(`insert into public.conversations (user_a, user_b) values ($1, $2)`, [a, b])).rejects.toThrow(/unique/);
    await expect(t.db.query(`insert into public.conversations (user_a, user_b) values ($1, $2)`, [b, a])).rejects.toThrow(/check constraint/);
  });

  it("참여자만 메시지를 조회하고, 제3자는 방·기록을 볼 수 없다", async () => {
    await openConversation();
    await serverSend(ME, "안녕하세요");
    await serverSend(M1, "반가워요");
    expect(await read(ME)).toEqual(["안녕하세요", "반가워요"]);
    expect(await read(M1)).toEqual(["안녕하세요", "반가워요"]);
    expect(await read(STRANGER)).toEqual([]);
    expect(await rowsAs(STRANGER, `select * from public.conversations`)).toEqual([]);
  });

  it("브라우저에서 메시지를 직접 쓰거나 고칠 수 없다 (C 의 서버 API 로만)", async () => {
    await openConversation();
    await expect(
      t.asUser(ME, (q) => q.query(`insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'x')`, [convId, ME])),
    ).rejects.toThrow(/permission denied/);
    await expect(rowsAs(ME, `update public.messages set body = '수정'`)).rejects.toThrow(/permission denied/);
  });

  it("차단하면 양쪽 모두 요청·방·기록·프로필이 보이지 않는다", async () => {
    await openConversation();
    await serverSend(ME, "첫 메시지");
    await t.asUser(M1, (q) => q.query(`insert into public.blocks (blocker_id, blocked_id) values ($1, $2)`, [M1, ME]));
    for (const u of [ME, M1]) {
      expect(await read(u)).toEqual([]);
      expect(await rowsAs(u, `select * from public.conversations`)).toEqual([]);
      expect(await rowsAs(u, `select * from public.chat_requests`)).toEqual([]);
    }
    expect(await visibleProfiles(M1)).toEqual([M1]);
    // 차단 해제 시 기록 복구
    await t.asUser(M1, (q) => q.query(`delete from public.blocks where blocker_id = $1`, [M1]));
    expect(await read(ME)).toEqual(["첫 메시지"]);
  });

  it("C 의 profileAvailable / blocked 판단 함수", async () => {
    const r = await t.asService((q) =>
      q.query<{ a: boolean; b: boolean; c: boolean }>(
        `select private.profile_available($1) a, private.profile_available($2) b, private.is_blocked_between($1, $3) c`,
        [M1, uid(12345), ME]));
    expect(r.rows[0]).toEqual({ a: true, b: false, c: false });
  });
});
