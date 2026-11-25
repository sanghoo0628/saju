/**
 * 추천받을 상대 성별 (20261125000200_match_preferences, 계약서 8장 2번)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { rankCandidates } from "../../src/lib/matching";
import { createTestDb, recommend, seedUsers, uid, type TestDb } from "./harness";

const ME = uid(1);

async function candidates(t: TestDb, user: string): Promise<string[]> {
  const r = await t.asService((q) =>
    q.query<{ user_id: string }>(`select user_id from private.match_candidates($1)`, [user]),
  );
  return r.rows.map((row) => row.user_id);
}

describe("추천받을 상대 성별", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });

  it("조건이 없으면(행 없음 = 상관없음) 기존 추천과 같다", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: "male" },
      { id: uid(10), score: -3490, gender: "female" },
      { id: uid(11), score: -3530, gender: "male" },
      { id: uid(12), score: -3600, gender: null },
    ]);
    expect(await candidates(t, ME)).toEqual([uid(10), uid(11), uid(12)]);
  });

  it("내 조건에 맞는 성별만 남기고, 성별 미입력 상대는 제외한다", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: "male", preferredGender: "female" },
      { id: uid(10), score: -3490, gender: "female" },
      { id: uid(11), score: -3530, gender: "male" },
      { id: uid(12), score: -3600, gender: null },
      { id: uid(13), score: -3700, gender: "female", preferredGender: "any" },
    ]);
    expect(await candidates(t, ME)).toEqual([uid(10), uid(13)]);
  });

  it("상대의 조건도 만족해야 한다 (서로)", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: "male" },                                  // 나는 상관없음
      { id: uid(10), score: -3490, gender: "female", preferredGender: "female" }, // 상대는 여성만 → ❌
      { id: uid(11), score: -3530, gender: "female", preferredGender: "male" },   // ✅
      { id: uid(12), score: -3600, gender: "male", preferredGender: "any" },      // ✅
    ]);
    expect(await candidates(t, ME)).toEqual([uid(11), uid(12)]);
  });

  it("내 성별이 비어 있으면 성별을 정한 상대에게는 추천되지 않는다", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: null },
      { id: uid(10), score: -3490, gender: "female", preferredGender: "male" }, // ❌
      { id: uid(11), score: -3530, gender: "female" },                          // ✅
    ]);
    expect(await candidates(t, ME)).toEqual([uid(11)]);
  });

  it("거른 뒤의 순위는 src/lib/matching.ts 기준 구현과 같다", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: "female", preferredGender: "male" },
      { id: uid(10), score: -3510, gender: "male" },
      { id: uid(11), score: -3490, gender: "male" },
      { id: uid(12), score: -3510, gender: "male", preferredGender: "female" },
      { id: uid(13), score: -3500, gender: "female" }, // 거리 0 이지만 성별 조건 ❌
    ]);
    const db = await t.asService((q) =>
      q.query<{ user_id: string; score: number }>(`select user_id, score from private.match_candidates($1)`, [ME]),
    );
    const ts = rankCandidates(ME, 3500, db.rows.map((r) => ({ userId: r.user_id, score: r.score })), 100);
    expect(db.rows.map((r) => r.user_id)).toEqual(ts.map((c) => c.userId));
    expect(db.rows.map((r) => r.user_id)).not.toContain(uid(13));
  });

  it("이미 저장된 추천은 조건을 바꿔도 다시 계산하지 않는다", async () => {
    await seedUsers(t.db, [
      { id: ME, score: 3500, gender: "male" },
      { id: uid(10), score: -3490, gender: "female" },
      { id: uid(11), score: -3530, gender: "male" },
    ]);
    expect((await recommend(t, ME)).map((r) => r.target_id)).toEqual([uid(10), uid(11)]);
    await t.db.query(`insert into public.match_preferences (user_id, preferred_gender) values ($1, 'female')`, [ME]);
    expect((await recommend(t, ME)).map((r) => r.target_id)).toEqual([uid(10), uid(11)]);
  });

  it("브라우저(anon/authenticated)는 추천 조건 표를 읽거나 쓸 수 없다", async () => {
    await seedUsers(t.db, [{ id: ME, score: 3500, gender: "male", preferredGender: "female" }]);
    await expect(t.asUser(ME, (q) => q.query(`select * from public.match_preferences`))).rejects.toThrow(/permission denied/);
    await expect(
      t.asUser(ME, (q) => q.query(`update public.match_preferences set preferred_gender = 'any' where user_id = $1`, [ME])),
    ).rejects.toThrow(/permission denied/);
  });

  it("값은 any/male/female 만 허용하고, 프로필이 없으면 저장할 수 없다", async () => {
    await seedUsers(t.db, [{ id: ME, score: 3500 }]);
    await expect(
      t.db.query(`insert into public.match_preferences (user_id, preferred_gender) values ($1, 'other')`, [ME]),
    ).rejects.toThrow();
    await expect(
      t.db.query(`insert into public.match_preferences (user_id, preferred_gender) values ($1, 'any')`, [uid(99)]),
    ).rejects.toThrow();
  });
});
