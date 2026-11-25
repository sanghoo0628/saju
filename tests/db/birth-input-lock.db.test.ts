/**
 * 20261125000400_birth_input_lock.sql 검증 (PGlite)
 * - 점수 생성 후 매칭용 생년월일 변경 금지, 같은 값 재저장 허용
 * - 점수는 현재 저장된 생년월일로 만든 것만 저장 (scored_birth_key 대조)
 * - 점수가 없으면 날짜를 자유롭게 바꿀 수 있다
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, uid, type TestDb } from "./harness";

const LOCKED = uid(21);
const FREE = uid(22);
const RACE = uid(23);
const LUNAR = uid(24);
let t: TestDb;

const saveBirth = (user: string, date: string, timezone = "Asia/Seoul") =>
  t.asService((q) => q.query(
    `insert into public.private_birth_data (user_id, calendar_type, birth_date, is_leap_month, timezone, consent_version, consented_at)
     values ($1, 'solar', $2, false, $3, 'matching_birth_storage_v1', now())
     on conflict (user_id) do update set calendar_type = excluded.calendar_type, birth_date = excluded.birth_date,
       lunar_date = excluded.lunar_date, is_leap_month = excluded.is_leap_month, timezone = excluded.timezone,
       consented_at = excluded.consented_at`,
    [user, date, timezone]));

const insertScore = (user: string, key: string | null) =>
  t.asService((q) => q.query(
    `insert into public.fortune_results (user_id, base_number, score, score_version, score_input, scored_birth_key)
     values ($1, 1234, -1234, 1, 'solar', $2) on conflict (user_id) do nothing`,
    [user, key]));

const storedDate = async (user: string) =>
  (await t.db.query<{ d: string }>(`select to_char(birth_date, 'YYYY-MM-DD') d from public.private_birth_data where user_id = $1`, [user])).rows[0]?.d;

beforeAll(async () => {
  t = await createTestDb();
  for (const id of [LOCKED, FREE, RACE, LUNAR]) {
    await t.db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@korea.ac.kr`]);
  }
}, 60_000);

describe("점수 생성 후 생년월일 고정", () => {
  it("점수가 없으면 날짜를 바꿀 수 있다", async () => {
    await saveBirth(FREE, "2003-05-20");
    await saveBirth(FREE, "2003-05-21");
    expect(await storedDate(FREE)).toBe("2003-05-21");
  });

  it("점수가 생긴 뒤 다른 날짜는 거부하고, 같은 날짜 재저장·시간대 변경은 허용한다", async () => {
    await saveBirth(LOCKED, "2003-05-20");
    await insertScore(LOCKED, "2003-05-20");
    await expect(saveBirth(LOCKED, "2003-05-21")).rejects.toThrow(/BIRTH_INPUT_LOCKED/);
    expect(await storedDate(LOCKED)).toBe("2003-05-20");
    await expect(saveBirth(LOCKED, "2003-05-20", "Asia/Tokyo")).resolves.toBeDefined();
    const tz = await t.db.query<{ timezone: string }>(`select timezone from public.private_birth_data where user_id = $1`, [LOCKED]);
    expect(tz.rows[0]?.timezone).toBe("Asia/Tokyo");
  });

  it("점수를 만드는 사이 날짜가 바뀌었으면 그 점수는 저장하지 않는다", async () => {
    await saveBirth(RACE, "2003-05-20");
    // 서버가 05-20 으로 점수를 계산하는 동안 다른 요청이 05-22 로 바꿔 먼저 커밋한 상황
    await saveBirth(RACE, "2003-05-22");
    await expect(insertScore(RACE, "2003-05-20")).rejects.toThrow(/BIRTH_INPUT_CHANGED/);
    const none = await t.db.query(`select 1 from public.fortune_results where user_id = $1`, [RACE]);
    expect(none.rows).toHaveLength(0);
    // 다시 시도하면 현재 날짜로 만든 점수는 저장된다
    await insertScore(RACE, "2003-05-22");
    await expect(saveBirth(RACE, "2003-05-20")).rejects.toThrow(/BIRTH_INPUT_LOCKED/);
  });

  it("음력 키도 score.ts 와 같은 형식으로 대조한다", async () => {
    await t.asService((q) => q.query(
      `insert into public.private_birth_data (user_id, calendar_type, lunar_date, is_leap_month, timezone, consent_version, consented_at)
       values ($1, 'lunar', '2001-04-30', true, 'Asia/Seoul', 'matching_birth_storage_v1', now())`, [LUNAR]));
    await expect(insertScore(LUNAR, "lunar:2001-04-30")).rejects.toThrow(/BIRTH_INPUT_CHANGED/);
    await expect(insertScore(LUNAR, "lunar-leap:2001-04-30")).resolves.toBeDefined();
  });

  it("scored_birth_key 없이 넣는 기존 방식(시드·이전 코드)은 대조 없이 저장된다", async () => {
    const id = uid(25);
    await t.db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@korea.ac.kr`]);
    await expect(insertScore(id, null)).resolves.toBeDefined();
  });
});
