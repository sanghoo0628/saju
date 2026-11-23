/**
 * 20261123000100_birth_input_and_analysis.sql 검증 (PGlite)
 * - 음력 원본 일자 저장, 달력별 필수 컬럼
 * - 사주 원문 없이 고정 점수만 저장
 * - fortune_analyses 는 브라우저 접근 불가, 서버만 읽고 쓰기
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, uid, type TestDb } from "./harness";

const ME = uid(1);
const OTHER = uid(2);
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  for (const id of [ME, OTHER]) {
    await t.db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@korea.ac.kr`]);
  }
}, 60_000);

const insertBirth = (sql: string, params: unknown[]) => t.asService((q) => q.query(sql, params));

describe("private_birth_data (양력·음력)", () => {
  it("음력은 양력 date 가 아닌 원문 문자열로 저장한다 (음력 2월 30일 허용)", async () => {
    await insertBirth(
      `insert into public.private_birth_data (user_id, calendar_type, lunar_date, is_leap_month, timezone, consent_version, consented_at)
       values ($1, 'lunar', '2001-02-30', true, 'Asia/Seoul', 'matching_birth_storage_v1', now())`,
      [ME],
    );
    const r = await t.db.query<{ birth_date: string | null; lunar_date: string; birth_time: string | null }>(
      `select birth_date, lunar_date, birth_time from public.private_birth_data where user_id = $1`, [ME]);
    expect(r.rows[0]).toEqual({ birth_date: null, lunar_date: "2001-02-30", birth_time: null });
  });

  it.each([
    [`insert into public.private_birth_data (user_id, calendar_type) values ($1, 'solar')`, "양력인데 날짜 없음"],
    [`insert into public.private_birth_data (user_id, calendar_type, birth_date, lunar_date) values ($1, 'solar', '2001-02-03', '2001-01-01')`, "양력에 음력 날짜"],
    [`insert into public.private_birth_data (user_id, calendar_type, birth_date) values ($1, 'lunar', '2001-02-03')`, "음력인데 양력 칸"],
    [`insert into public.private_birth_data (user_id, calendar_type, lunar_date) values ($1, 'lunar', '2001-02-31')`, "음력 31일"],
    [`insert into public.private_birth_data (user_id, calendar_type, lunar_date) values ($1, 'lunar', '2001-13-01')`, "음력 13월"],
    [`insert into public.private_birth_data (user_id, calendar_type, birth_date, is_leap_month) values ($1, 'solar', '2001-02-03', true)`, "양력 윤달"],
    [`insert into public.private_birth_data (user_id, calendar_type, birth_date, consent_version) values ($1, 'solar', '2001-02-03', 'v1')`, "동의 시각 누락"],
  ])("거부: %s (%s)", async (sql) => {
    await expect(insertBirth(sql, [OTHER])).rejects.toThrow(/violates/);
  });
});

describe("fortune_results (고정 점수만 저장)", () => {
  it("사주 원문 없이 점수와 입력 종류만 저장할 수 있다", async () => {
    await t.asService((q) => q.query(
      `insert into public.fortune_results (user_id, base_number, score, score_version, score_input)
       values ($1, 4321, -4321, 1, 'lunar_leap')`, [ME]));
    const r = await t.db.query<{ score: number; score_input: string; fortune: unknown }>(
      `select score, score_input, fortune from public.fortune_results where user_id = $1`, [ME]);
    expect(r.rows[0]).toEqual({ score: -4321, score_input: "lunar_leap", fortune: null });
  });

  it("먼저 저장된 점수는 on conflict do nothing 으로 유지된다", async () => {
    await t.asService((q) => q.query(
      `insert into public.fortune_results (user_id, base_number, score, score_version)
       values ($1, 1, 1, 1) on conflict (user_id) do nothing`, [ME]));
    const r = await t.db.query<{ score: number }>(`select score from public.fortune_results where user_id = $1`, [ME]);
    expect(r.rows[0]!.score).toBe(-4321);
  });

  it("사주 원문과 프로그램 버전은 함께 있거나 함께 없다", async () => {
    await expect(t.asService((q) => q.query(
      `insert into public.fortune_results (user_id, base_number, score, score_version, fortune)
       values ($1, 5, 5, 1, '{}')`, [OTHER]))).rejects.toThrow(/violates/);
    await expect(t.asService((q) => q.query(
      `insert into public.fortune_results (user_id, base_number, score, score_version, score_input)
       values ($1, 5, 5, 1, 'other')`, [OTHER]))).rejects.toThrow(/violates/);
  });
});

describe("fortune_analyses (A 3주 분석)", () => {
  const insert = `insert into public.fortune_analyses
    (user_id, schema_version, chart_basis, provider, adapter_version, fortune_schema_version,
     input_fingerprint, comparison_key, calculated_at, chart, calculation, analysis)
    values ($1, 'matching_fortune_v1', 'three_pillars', 'hrum', 'a1', 'fortune_v2', 'fp', $2, now(), '{}', '{}', '{}')`;

  it("서버는 저장·조회할 수 있다", async () => {
    await t.asService((q) => q.query(insert, [ME, "a".repeat(64)]));
    const r = await t.asService((q) => q.query(`select user_id from public.fortune_analyses`));
    expect(r.rows).toHaveLength(1);
  });

  it("브라우저(본인 포함)·비로그인은 읽거나 쓸 수 없다", async () => {
    await expect(t.asUser(ME, (q) => q.query(`select * from public.fortune_analyses`))).rejects.toThrow(/permission denied/);
    await expect(t.asUser(null, (q) => q.query(`select * from public.fortune_analyses`))).rejects.toThrow(/permission denied/);
    await expect(t.asUser(OTHER, (q) => q.query(insert, [OTHER, "b".repeat(64)]))).rejects.toThrow(/permission denied/);
  });

  it("4주 기준·잘못된 비교 키는 저장하지 않는다", async () => {
    await expect(t.asService((q) => q.query(insert.replace("'three_pillars'", "'four_pillars'"), [OTHER, "b".repeat(64)])))
      .rejects.toThrow(/violates/);
    await expect(t.asService((q) => q.query(insert, [OTHER, "not-hex"]))).rejects.toThrow(/violates/);
  });

  it("계정이 삭제되면 함께 삭제된다", async () => {
    await t.db.query(`delete from auth.users where id = $1`, [ME]);
    const r = await t.db.query(`select 1 from public.fortune_analyses where user_id = $1`, [ME]);
    expect(r.rows).toHaveLength(0);
  });
});
