import { beforeEach, describe, expect, it } from "vitest";
import {
  createMatchingService,
  MatchingError,
  parseUpdateProfile,
  type MatchingStore,
  type ProfileRow,
  type StoredMatchResult,
  type BirthInputWrite,
  type FortuneAnalysisWrite,
  type FortuneInputForStorage,
} from "../src/server/matching-service";
import { computeScore, type BirthInput } from "../src/lib/score";
import type { PreferredGender } from "../src/contracts/matching";

const ME = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function memoryStore() {
  const profiles = new Map<string, ProfileRow>();
  const scores = new Map<string, number>();
  const births = new Map<string, BirthInputWrite>();
  const analyses = new Map<string, FortuneAnalysisWrite>();
  const prefs = new Map<string, PreferredGender>();
  let recs: StoredMatchResult[] = [];
  const store: MatchingStore = {
    profile: async (id) => profiles.get(id),
    fortuneScore: async (id) => scores.get(id),
    birthInput: async (id): Promise<BirthInput | undefined> => {
      const b = births.get(id);
      return b && { calendar: b.calendar, date: b.date, isLeapMonth: b.isLeapMonth };
    },
    saveBirthInput: async (row) => void births.set(row.userId, row),
    insertScoreIfAbsent: async (id, s) => {
      if (!scores.has(id)) scores.set(id, s.score);
      return scores.get(id)!;
    },
    saveFortuneAnalysis: async (row) => void analyses.set(row.userId, row),
    upsertProfile: async (row) => {
      const saved = { ...row, isActive: profiles.get(row.userId)?.isActive ?? true };
      profiles.set(row.userId, saved);
      return saved;
    },
    matchPreference: async (id) => prefs.get(id) ?? "any",
    saveMatchPreference: async (id, pref) => {
      if (!profiles.has(id)) throw new Error("profile required (FK)");
      prefs.set(id, pref);
    },
    getOrCreateMatchResults: async () => recs,
    profiles: async (ids) => ids.map((id) => profiles.get(id)).filter((p): p is ProfileRow => !!p),
    signPhotoUrls: async (paths) => new Map(paths.map((p) => [p, `https://signed.example/${p}?token=x`])),
  };
  return { store, profiles, scores, births, analyses, prefs, setRecs: (r: StoredMatchResult[]) => (recs = r) };
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

  it("계열은 humanities/science 만 받는다", () => {
    expect(parseUpdateProfile({ nickname: "호랑이", isPublic: true, track: "science" }, ME)).toEqual({
      nickname: "호랑이", isPublic: true, track: "science",
    });
  });

  it("추천받을 상대 성별은 any/male/female 만 받는다", () => {
    for (const preferredGender of ["any", "male", "female"] as const) {
      expect(parseUpdateProfile({ nickname: "호랑이", isPublic: true, preferredGender }, ME)).toEqual({
        nickname: "호랑이", isPublic: true, preferredGender,
      });
    }
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
    [{ nickname: "ab", isPublic: true, preferredGender: "other" }, "추천 상대 성별 값"],
    [{ nickname: "ab", isPublic: true, preferredGender: null }, "추천 상대 성별 null"],
    [{ nickname: "ab", isPublic: true, interests: Array.from({ length: 11 }, (_, i) => `i${i}`) }, "관심사 개수"],
    [{ nickname: "ab", isPublic: true, track: "other" }, "계열 값"],
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
    await svc.recordBirthInput(ME, { birthDate: "2003-05-17", calendar: "solar", isLeapMonth: false, timezone: "Asia/Seoul" });
    expect((await svc.matchResults(ME)).status).toBe("profile_required");
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
  const SECRET = "test-secret";
  const solar = { birthDate: "2003-05-17", calendar: "solar", isLeapMonth: false, timezone: "Asia/Seoul" } as const;

  it("생년월일이 저장되지 않았으면 프로필을 만들 수 없다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store, { scoreSecret: SECRET });
    await expect(svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "science" })).rejects.toMatchObject({ code: "FORTUNE_REQUIRED" });
  });

  it("첫 저장에는 계열이 필요하고, 비밀 키가 없으면 점수를 만들지 않는다", async () => {
    const m = memoryStore();
    await createMatchingService(m.store, { scoreSecret: SECRET }).recordBirthInput(ME, solar);
    await expect(createMatchingService(m.store, { scoreSecret: SECRET }).updateProfile(ME, { nickname: "ab", isPublic: true }))
      .rejects.toMatchObject({ code: "TRACK_REQUIRED" });
    await expect(createMatchingService(m.store).updateProfile(ME, { nickname: "ab", isPublic: true, track: "science" }))
      .rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(m.scores.has(ME)).toBe(false);
  });

  it("첫 저장 때 저장된 생년월일 + 계열로 고정 점수를 만들고, 이후 계열은 바꿀 수 없다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store, { scoreSecret: SECRET });
    await svc.recordBirthInput(ME, solar);
    const saved = await svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "science" });
    expect(saved.track).toBe("science");
    expect(m.scores.get(ME)).toBe(computeScore("2003-05-17", "science", SECRET).score);
    expect(m.scores.get(ME)).toBe(-8352);
    await expect(svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "humanities" })).rejects.toMatchObject({ code: "TRACK_LOCKED" });
    // 같은 계열을 다시 보내거나 생략하면 통과, 생년월일을 다시 저장해도 점수는 그대로
    await svc.updateProfile(ME, { nickname: "cd", isPublic: true, track: "science" });
    await svc.recordBirthInput(ME, { ...solar, birthDate: "1999-01-01" });
    await svc.updateProfile(ME, { nickname: "ef", isPublic: true });
    expect(m.scores.get(ME)).toBe(-8352);
  });

  it("profileState 는 다음 단계에 필요한 상태만 알려준다 (생년월일·점수 숫자 없음)", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store, { scoreSecret: SECRET });
    expect(await svc.profileState(ME)).toEqual({ profile: null, birthInputSaved: false, lockedTrack: null });
    await svc.recordBirthInput(ME, solar);
    expect(await svc.profileState(ME)).toEqual({ profile: null, birthInputSaved: true, lockedTrack: null });
    await svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "humanities" });
    const state = await svc.profileState(ME);
    expect(state).toMatchObject({ birthInputSaved: true, lockedTrack: "humanities", profile: { nickname: "ab", isPublic: true } });
    expect(JSON.stringify(state)).not.toMatch(/2003|8352|score|birthDate/);
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

  it("추천받을 상대 성별: 처음은 any, 보낸 값만 저장하고 생략하면 유지한다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    m.scores.set(ME, 4200);
    expect((await svc.updateProfile(ME, { nickname: "ab", isPublic: true })).preferredGender).toBe("any");
    expect(m.prefs.has(ME)).toBe(false);
    expect((await svc.updateProfile(ME, { nickname: "ab", isPublic: true, preferredGender: "female" })).preferredGender).toBe("female");
    expect((await svc.updateProfile(ME, { nickname: "cd", isPublic: true })).preferredGender).toBe("female");
    expect((await svc.profileState(ME)).profile?.preferredGender).toBe("female");
    expect((await svc.myProfile(ME))?.preferredGender).toBe("female");
  });

  it("첫 저장에서도 프로필을 먼저 만든 뒤 추천 조건을 저장한다 (profiles 참조)", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store, { scoreSecret: SECRET });
    await svc.recordBirthInput(ME, solar);
    const saved = await svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "science", preferredGender: "male" });
    expect(saved.preferredGender).toBe("male");
    expect(m.prefs.get(ME)).toBe("male");
  });

  it("추천받을 상대 성별은 다른 사람의 추천 카드에 나오지 않는다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    m.scores.set(ME, 3500);
    m.profiles.set(ME, profile(ME));
    m.profiles.set(A, profile(A));
    m.prefs.set(A, "female");
    m.setRecs([{ id: "r1", targetId: A, rank: 1 }]);
    const res = await svc.matchResults(ME);
    expect(res.results[0]!.profile).not.toHaveProperty("preferredGender");
    expect(JSON.stringify(res)).not.toContain("preferred");
  });
});

describe("recordBirthInput (A 사주 화면 → B 저장)", () => {
  it("양력·음력·윤달을 구분해 저장하고 출생 시간은 받지 않는다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    await svc.recordBirthInput(ME, { birthDate: " 2001-02-30 ", calendar: "lunar", isLeapMonth: true, timezone: "Asia/Seoul" });
    expect(m.births.get(ME)).toEqual({
      userId: ME, calendar: "lunar", date: "2001-02-30", isLeapMonth: true, timezone: "Asia/Seoul",
      consentVersion: "matching_birth_storage_v1",
    });
  });

  it.each([
    [{ birthDate: "2001-02-30", calendar: "solar", isLeapMonth: false, timezone: "Asia/Seoul" }, "없는 양력 날짜"],
    [{ birthDate: "2001-02-03", calendar: "solar", isLeapMonth: true, timezone: "Asia/Seoul" }, "양력 윤달"],
    [{ birthDate: "2001-13-01", calendar: "lunar", isLeapMonth: false, timezone: "Asia/Seoul" }, "음력 13월"],
    [{ birthDate: "2001-02-31", calendar: "lunar", isLeapMonth: false, timezone: "Asia/Seoul" }, "음력 31일"],
    [{ birthDate: "2001-02-03", calendar: "solar", isLeapMonth: false, timezone: " " }, "시간대 없음"],
  ] as [FortuneInputForStorage, string][])("거부: %j (%s)", async (input) => {
    const m = memoryStore();
    await expect(createMatchingService(m.store).recordBirthInput(ME, input)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(m.births.size).toBe(0);
  });

  it("음력 입력도 고정 점수를 만들며 같은 숫자의 양력과는 다른 키를 쓴다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store, { scoreSecret: "test-secret" });
    await svc.recordBirthInput(ME, { birthDate: "2003-05-17", calendar: "lunar", isLeapMonth: false, timezone: "Asia/Seoul" });
    await svc.updateProfile(ME, { nickname: "ab", isPublic: true, track: "humanities" });
    const lunarScore = m.scores.get(ME)!;
    expect(lunarScore).toBeGreaterThanOrEqual(1);
    expect(lunarScore).toBeLessThanOrEqual(10000);
    expect(lunarScore).not.toBe(8352);
  });
});

describe("recordMatchingAnalysis (A 3주 분석 저장)", () => {
  const dto = {
    status: "ready", userId: ME, schemaVersion: "matching_fortune_v1", chartBasis: "three_pillars",
    provider: "hrum", adapterVersion: "a1", fortuneSchemaVersion: "fortune_v2", inputFingerprint: "fp",
    comparisonKey: "c".repeat(64), calculatedAt: "2026-11-23T00:00:00.000Z",
    chart: { year: {} }, calculation: { timezone: "Asia/Seoul" }, analysis: { strength: {} },
  } as const;

  it("본인 결과만 저장한다", async () => {
    const m = memoryStore();
    const svc = createMatchingService(m.store);
    await svc.recordMatchingAnalysis(ME, dto);
    expect(m.analyses.get(ME)).toMatchObject({ userId: ME, provider: "hrum", comparisonKey: "c".repeat(64) });
    await expect(svc.recordMatchingAnalysis(ME, { ...dto, userId: A })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(m.analyses.has(A)).toBe(false);
  });
});
