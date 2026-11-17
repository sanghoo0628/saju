/**
 * 무료 추천: 후보 필터, 거리순 상위 3명, 저장·유지 (개발 계획 2장 + 2026-11-16 기획 변경)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { rankCandidates } from "../../src/lib/matching";
import { createTestDb, recommend, seedUsers, uid, type TestDb } from "./harness";

const ME = uid(1);

describe("후보 필터와 순위", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await seedUsers(t.db, [
      { id: ME, score: 3500 },
      { id: uid(10), score: -3490 },                    // 거리 10  ✅
      { id: uid(11), score: -3530 },                    // 거리 30  ✅
      { id: uid(12), score: -3600 },                    // 거리 100 ✅
      { id: uid(13), score: -2900 },                    // 거리 600 ✅ (4위)
      { id: uid(20), score: -3500, isActive: false },   // 비활성 ❌
      { id: uid(21), score: -3500, isPublic: false },   // 공개 미동의 ❌
      { id: uid(22), score: -3500 },                    // 내가 차단 ❌
      { id: uid(23), score: -3500 },                    // 나를 차단 ❌
      { id: uid(24), score: null },                     // 사주 결과 없음 ❌
    ]);
    await t.db.query(`insert into public.blocks values ($1, $2), ($3, $1)`, [ME, uid(22), uid(23)]);
  });

  it("본인·비활성·비공개·차단(양방향)·점수 없음을 제외하고 거리순으로 정렬한다", async () => {
    const r = await t.asService((q) =>
      q.query<{ user_id: string; distance: number }>(`select user_id, distance from private.match_candidates($1)`, [ME]),
    );
    expect(r.rows).toEqual([
      { user_id: uid(10), distance: 10 },
      { user_id: uid(11), distance: 30 },
      { user_id: uid(12), distance: 100 },
      { user_id: uid(13), distance: 600 },
    ]);
  });

  it("개발 계획 예시대로 상위 3명이 무료 추천으로 저장된다", async () => {
    const recs = await recommend(t, ME);
    expect(recs.map(({ target_id, rank, distance }) => ({ target_id, rank, distance }))).toEqual([
      { target_id: uid(10), rank: 1, distance: 10 },
      { target_id: uid(11), rank: 2, distance: 30 },
      { target_id: uid(12), rank: 3, distance: 100 },
    ]);
    const stored = await t.db.query(`select * from public.match_results where user_id = $1`, [ME]);
    expect(stored.rows).toHaveLength(3);
  });

  it("DB 선정 결과가 src/lib/matching.ts 기준 구현과 같다 (동점 포함)", async () => {
    await seedUsers(t.db, [
      { id: uid(30), score: -3510 },
      { id: uid(31), score: -3490 },
      { id: uid(32), score: -3510 },
    ]);
    const db = await t.asService((q) =>
      q.query<{ user_id: string; score: number }>(`select user_id, score from private.match_candidates($1)`, [ME]),
    );
    const ts = rankCandidates(ME, 3500, db.rows.map((r) => ({ userId: r.user_id, score: r.score })), 100);
    expect(db.rows.map((r) => r.user_id)).toEqual(ts.map((c) => c.userId));
  });

  it("요청자가 공개 미동의·비활성·점수 없음이면 추천 0명", async () => {
    await t.db.query(`update public.profiles set is_public = false where id = $1`, [ME]);
    expect(await recommend(t, ME)).toEqual([]);
  });

  it("로그인 사용자는 추천 함수를 직접 호출할 수 없다", async () => {
    await expect(
      t.asUser(ME, (q) => q.query(`select * from public.get_or_create_match_results($1)`, [uid(10)])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("추천 결과 유지", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    await seedUsers(t.db, [
      { id: ME, score: 3500 },
      { id: uid(10), score: -3490 },
      { id: uid(11), score: -3530 },
      { id: uid(12), score: -3600 },
      { id: uid(13), score: -2900 },
    ]);
  });

  it("다시 조회하면 같은 결과·같은 ID (더 가까운 사람이 새로 가입해도)", async () => {
    const first = await recommend(t, ME);
    await seedUsers(t.db, [{ id: uid(50), score: -3500 }]);
    expect(await recommend(t, ME)).toEqual(first);
  });

  it("후보가 부족했던 사용자는 나중에 부족한 만큼만 채워진다", async () => {
    await t.db.query(`update public.profiles set is_public = false where id in ($1, $2, $3)`, [uid(11), uid(12), uid(13)]);
    const first = await recommend(t, ME);
    expect(first.map((r) => r.target_id)).toEqual([uid(10)]);

    await t.db.query(`update public.profiles set is_public = true where id in ($1, $2, $3)`, [uid(11), uid(12), uid(13)]);
    const second = await recommend(t, ME);
    expect(second.map((r) => [r.target_id, r.rank])).toEqual([[uid(10), 1], [uid(11), 2], [uid(12), 3]]);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("추천된 상대가 비공개·차단되면 숨기되 다른 사람으로 다시 채우지 않는다", async () => {
    await recommend(t, ME);
    await t.db.query(`update public.profiles set is_public = false where id = $1`, [uid(10)]);
    await t.db.query(`insert into public.blocks values ($1, $2)`, [ME, uid(11)]);
    expect((await recommend(t, ME)).map((r) => r.target_id)).toEqual([uid(12)]);
  });
});
