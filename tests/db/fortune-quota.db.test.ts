/**
 * 20261125000100_fortune_provider_quota.sql 검증 (PGlite)
 * - 사용자별·전체 일일 한도, 한국 날짜 기준 원자적 확보
 * - 사용자 한도에 걸린 요청은 전체 카운트를 소비하지 않는다
 * - 브라우저(authenticated/anon)는 함수·테이블에 접근 불가
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, uid, type TestDb } from "./harness";

const A = uid(11);
const B = uid(12);
const C = uid(13);
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  for (const id of [A, B, C]) {
    await t.db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@korea.ac.kr`]);
  }
}, 60_000);

const claim = (user: string, userLimit: number, totalLimit: number) =>
  t.asService(async (q) => (await q.query<{ r: string }>(
    `select public.claim_fortune_provider_call($1, $2, $3) as r`, [user, userLimit, totalLimit])).rows[0]!.r);

const counts = async () => {
  const total = await t.db.query<{ calls: number }>(
    `select calls from public.fortune_provider_daily_total where usage_date = (now() at time zone 'Asia/Seoul')::date`);
  const users = await t.db.query<{ user_id: string; calls: number }>(
    `select user_id, calls from public.fortune_provider_usage order by user_id`);
  return { total: total.rows[0]?.calls ?? 0, users: Object.fromEntries(users.rows.map((r) => [r.user_id, r.calls])) };
};

describe("claim_fortune_provider_call", () => {
  it("사용자별 한도까지만 허용하고, 거부된 요청은 전체 카운트를 쓰지 않는다", async () => {
    expect(await claim(A, 2, 100)).toBe("ok");
    expect(await claim(A, 2, 100)).toBe("ok");
    expect(await claim(A, 2, 100)).toBe("user_limit");
    expect(await counts()).toEqual({ total: 2, users: { [A]: 2 } });
  });

  it("전체 일일 상한에 걸리면 사용자 카운트도 늘지 않는다", async () => {
    expect(await claim(B, 5, 3)).toBe("ok");
    expect(await claim(C, 5, 3)).toBe("total_limit");
    const c = await counts();
    expect(c.total).toBe(3);
    expect(c.users[C]).toBeUndefined();
  });

  it("잘못된 한도 인자는 거부한다", async () => {
    await expect(claim(A, 0, 10)).rejects.toThrow(/invalid fortune quota/);
    await expect(claim(A, 5, 0)).rejects.toThrow(/invalid fortune quota/);
  });

  it("브라우저 역할은 함수와 사용량 테이블에 접근할 수 없다", async () => {
    for (const who of [A, null]) {
      await expect(t.asUser(who, (q) => q.query(`select public.claim_fortune_provider_call($1, 5, 15)`, [A])))
        .rejects.toThrow(/permission denied/);
      await expect(t.asUser(who, (q) => q.query(`select * from public.fortune_provider_usage`)))
        .rejects.toThrow(/permission denied/);
      await expect(t.asUser(who, (q) => q.query(`select * from public.fortune_provider_daily_total`)))
        .rejects.toThrow(/permission denied/);
    }
  });
});
