import { describe, expect, it } from "vitest";
import { matchDistance, rankCandidates } from "../src/lib/matching";

const ME = "00000000-0000-0000-0000-000000000000";
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

describe("matchDistance", () => {
  it("abs(내 점수 + 상대 점수)", () => {
    expect(matchDistance(3500, -3490)).toBe(10);
    expect(matchDistance(-3500, 3600)).toBe(100);
    expect(matchDistance(3500, 100)).toBe(3600);
  });
});

describe("rankCandidates", () => {
  it("개발 계획 예시: 내 점수 3500 → A, B, C 순", () => {
    const result = rankCandidates(ME, 3500, [
      { userId: id(4), score: -2900 }, // D: 600
      { userId: id(3), score: -3600 }, // C: 100
      { userId: id(1), score: -3490 }, // A: 10
      { userId: id(2), score: -3530 }, // B: 30
    ]);
    expect(result).toEqual([
      { userId: id(1), score: -3490, distance: 10, rank: 1 },
      { userId: id(2), score: -3530, distance: 30, rank: 2 },
      { userId: id(3), score: -3600, distance: 100, rank: 3 },
    ]);
  });

  it("동점이면 user_id 오름차순, 입력 순서와 무관", () => {
    const cands = [
      { userId: id(9), score: -3510 },
      { userId: id(5), score: -3490 },
      { userId: id(7), score: -3510 },
      { userId: id(6), score: -3490 },
    ];
    const a = rankCandidates(ME, 3500, cands).map((c) => c.userId);
    const b = rankCandidates(ME, 3500, [...cands].reverse()).map((c) => c.userId);
    expect(a).toEqual([id(5), id(6), id(7)]);
    expect(b).toEqual(a);
  });

  it("같은 계열도 거리가 가까우면 추천될 수 있다 (반대 계열 강제 아님)", () => {
    const result = rankCandidates(ME, 10, [
      { userId: id(1), score: 20 }, // 30
      { userId: id(2), score: -5000 }, // 4990
    ], 1);
    expect(result[0]?.userId).toBe(id(1));
  });

  it("본인과 중복 후보는 제외한다", () => {
    const result = rankCandidates(ME, 100, [
      { userId: ME, score: -100 },
      { userId: id(1), score: -100 },
      { userId: id(1).toUpperCase(), score: -100 },
    ]);
    expect(result.map((r) => r.userId)).toEqual([id(1)]);
  });

  it("후보가 3명 미만이면 있는 만큼만 반환한다", () => {
    expect(rankCandidates(ME, 1, [{ userId: id(1), score: 1 }])).toHaveLength(1);
    expect(rankCandidates(ME, 1, [])).toEqual([]);
  });
});
