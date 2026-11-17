import { beforeEach, describe, expect, it } from "vitest";
import {
  createMatchingService,
  MatchingError,
  parseUpdateProfile,
  type MatchingStore,
  type ProfileRow,
  type StoredMatchResult,
} from "../src/server/matching-service";

const ME = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function memoryStore() {
  const profiles = new Map<string, ProfileRow>();
  const scores = new Map<string, number>();
  let recs: StoredMatchResult[] = [];
  const store: MatchingStore = {
    profile: async (id) => profiles.get(id),
    fortuneScore: async (id) => scores.get(id),
    upsertProfile: async (row) => {
      const saved = { ...row, isActive: profiles.get(row.userId)?.isActive ?? true };
      profiles.set(row.userId, saved);
      return saved;
    },
    getOrCreateMatchResults: async () => recs,
    profiles: async (ids) => ids.map((id) => profiles.get(id)).filter((p): p is ProfileRow => !!p),
    signPhotoUrls: async (paths) => new Map(paths.map((p) => [p, `https://signed.example/${p}?token=x`])),
  };
  return { store, profiles, scores, setRecs: (r: StoredMatchResult[]) => (recs = r) };
}

const profile = (userId: string, extra: Partial<ProfileRow> = {}): ProfileRow => ({
  userId, nickname: `n-${userId.slice(0, 4)}`, gender: null, university: null, major: null, bio: "",
  interests: [], track: "science", photoPath: null, isPublic: true, isActive: true, ...extra,
});

describe("parseUpdateProfile", () => {
  it("정상 입력을 다듬어 반환한다", () => {
    expect(
      parseUpdateProfile({
        nickname: " 호랑이 ", bio: " 안녕 ", isPublic: true, photoPath: `${ME}/p.jpg`,
        gender: "female", university: " 고려대 ", major: "", interests: ["등산", " 등산 ", "영화"],
      }, ME),
    ).toEqual({
      nickname: "호랑이", bio: "안녕", isPublic: true, photoPath: `${ME}/p.jpg`,
      gender: "female", university: "고려대", major: null, interests: ["등산", "영화"],
    });
  });

  it("생략한 항목은 결과에 넣지 않는다 (기존 값 유지용)", () => {
    expect(parseUpdateProfile({ nickname: "호랑이", isPublic: false }, ME)).toEqual({ nickname: "호랑이", isPublic: false });
  });

  it.each([
    [{ nickname: "a", isPublic: true }, "짧은 닉네임"],
    [{ nickname: "x".repeat(21), isPublic: true }, "긴 닉네임"],
    [{ nickname: "ab", bio: "x".repeat(301), isPublic: true }, "긴 소개"],
    [{ nickname: "ab" }, "공개 동의 누락"],
    [{ nickname: "ab", isPublic: true, gender: "other" }, "성별 값"],
    [{ nickname: "ab", isPublic: true, interests: Array.from({ length: 11 }, (_, i) => `i${i}`) }, "관심사 개수"],
    [{ nickname: "ab", isPublic: true, track: "humanities" }, "계열 직접 입력"],
    [{ nickname: "ab", isPublic: true, userId: A }, "사용자 ID 입력"],
    [{ nickname: "ab", isPublic: true, photoPath: `${A}/p.jpg` }, "남의 사진 폴더"],
    [{ nickname: "ab", isPublic: true, photoPath: `${ME}/../x.jpg` }, "경로 탈출"],
    [null, "본문 없음"],
  ] as [unknown, string][])("거부: %j (%s)", (body) => {
    expect(() => parseUpdateProfile(body, ME)).toThrow(MatchingError);
  });
});

describe("matchResults (GET /api/match-results)", () => {
  let m: ReturnType<typeof memoryStore>;
  let svc: ReturnType<typeof createMatchingService>;
  beforeEach(() => {
    m = memoryStore();
    svc = createMatchingService(m.store);
  });

  it("로그인 필요", async () => {
    await expect(svc.matchResults(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("사주 결과·공개 프로필이 없으면 안내 상태를 반환한다", async () => {
    expect((await svc.matchResults(ME)).status).toBe("fortune_required");
    m.scores.set(ME, 3500);
    expect((await svc.matchResults(ME)).status).toBe("profile_required");
    m.profiles.set(ME, profile(ME, { isPublic: false }));
    expect((await svc.matchResults(ME)).status).toBe("profile_required");
    m.profiles.set(ME, profile(ME, { isActive: false }));
    expect((await svc.matchResults(ME)).status).toBe("profile_required");
    m.profiles.set(ME, profile(ME));
    expect((await svc.matchResults(ME)).status).toBe("no_candidates");
  });

  it("추천 결과 ID 와 프로필 카드를 순위순으로 반환한다 (C 의 matchResultId)", async () => {
    m.scores.set(ME, 3500);
    m.profiles.set(ME, profile(ME));
    m.profiles.set(A, profile(A, { photoPath: `${A}/a.jpg`, university: "고려대" }));
    m.profiles.set(B, profile(B));
    m.setRecs([{ id: "r2", targetId: B, rank: 2 }, { id: "r1", targetId: A, rank: 1 }]);
    const res = await svc.matchResults(ME);
    expect(res.status).toBe("ready");
    expect(res.results.map((r) => [r.id, r.rank, r.profile.userId])).toEqual([["r1", 1, A], ["r2", 2, B]]);
    expect(res.results[0]!.profile).toMatchObject({ university: "고려대", photoUrl: `https://signed.example/${A}/a.jpg?token=x` });
    // 카드에는 공개 항목만 (점수·생년월일·공개 상태 없음)
    expect(Object.keys(res.results[0]!.profile).sort()).toEqual(
      ["bio", "gender", "interests", "major", "nickname", "photoUrl", "track", "university", "userId"],
    );
  });
});

describe("updateProfile (PUT /api/profile)", () => {
  it("사주 결과가 없으면 프로필을 만들 수 없다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    await expect(svc.updateProfile(ME, { nickname: "ab", isPublic: true })).rejects.toMatchObject({ code: "FORTUNE_REQUIRED" });
  });

  it("계열은 저장된 점수 부호로 정해지고, 생략한 항목은 유지된다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    m.scores.set(ME, 4200);
    const first = await svc.updateProfile(ME, {
      nickname: "ab", bio: "소개", isPublic: false, photoPath: `${ME}/p.jpg`, interests: ["등산"], major: "경영",
    });
    expect(first.track).toBe("humanities");
    const second = await svc.updateProfile(ME, { nickname: "cd", isPublic: true });
    expect(second).toMatchObject({ nickname: "cd", bio: "소개", isPublic: true, track: "humanities", interests: ["등산"], major: "경영" });
    expect(second.photoUrl).toContain(`${ME}/p.jpg`);
    m.scores.set(ME, -4200);
    const third = await svc.updateProfile(ME, { nickname: "cd", isPublic: true, photoPath: null, major: null });
    expect(third).toMatchObject({ track: "science", photoUrl: null, major: null });
  });
});
