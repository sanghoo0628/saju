/**
 * B 담당 서버 로직: 프로필 등록·수정, 무료 추천 조회.
 * 서버 전용. 저장소는 주입한다 (운영: supabase-store.ts, 테스트: 메모리 구현).
 * userId 는 반드시 A 의 서버 세션에서 가져온다. 요청 본문의 사용자 ID 를 믿지 않는다.
 */
import { PROFILE_LIMITS } from "../contracts/matching";
import type {
  Gender,
  MatchingErrorCode,
  MatchResultCard,
  MatchResultsResponse,
  MyProfileResponse,
  PreferredGender,
  ProfileCard,
  ProfileStateResponse,
  UpdateProfileRequest,
} from "../contracts/matching";
import {
  computeScoreForBirthInput,
  InvalidBirthDateError,
  isTrack,
  scoreKey,
  type BirthInput,
  type ComputedBirthScore,
  type Track,
} from "../lib/score";

export interface ProfileRow {
  userId: string;
  nickname: string;
  gender: Gender | null;
  university: string | null;
  major: string | null;
  bio: string;
  interests: string[];
  track: Track;
  photoPath: string | null;
  isPublic: boolean;
  /** status = 'active' */
  isActive: boolean;
}

export type ProfileWrite = Omit<ProfileRow, "isActive">;

export interface StoredMatchResult {
  id: string;
  targetId: string;
  rank: number;
}

/** private_birth_data 에 저장하는 값. 출생 시간은 저장하지 않는다. */
export interface BirthInputWrite extends BirthInput {
  userId: string;
  timezone: string;
  consentVersion: string;
}

/** A 의 MatchingFortuneInput(status = ready) 중 저장하는 필드. 출생 입력은 없다. */
export interface FortuneAnalysisWrite {
  userId: string;
  schemaVersion: "matching_fortune_v1";
  chartBasis: "three_pillars";
  provider: string;
  adapterVersion: string;
  fortuneSchemaVersion: string;
  inputFingerprint: string;
  comparisonKey: string;
  calculatedAt: string;
  chart: unknown;
  calculation: unknown;
  analysis: unknown;
}

export interface MatchingStore {
  profile(userId: string): Promise<ProfileRow | undefined>;
  /** fortune_results.score (없으면 undefined) */
  fortuneScore(userId: string): Promise<number | undefined>;
  /** private_birth_data (없으면 undefined) */
  birthInput(userId: string): Promise<BirthInput | undefined>;
  saveBirthInput(row: BirthInputWrite): Promise<void>;
  /** 점수가 없을 때만 넣고, 최종 저장된 점수를 돌려준다 (동시 요청에도 먼저 저장된 값 유지) */
  insertScoreIfAbsent(userId: string, score: ComputedBirthScore): Promise<number>;
  saveFortuneAnalysis(row: FortuneAnalysisWrite): Promise<void>;
  upsertProfile(row: ProfileWrite): Promise<ProfileRow>;
  /** match_preferences.preferred_gender (행이 없으면 any) */
  matchPreference(userId: string): Promise<PreferredGender>;
  /** 프로필이 있어야 저장할 수 있다 (profiles 참조) */
  saveMatchPreference(userId: string, preferredGender: PreferredGender): Promise<void>;
  /** DB 함수 get_or_create_match_results — 공개·활성·차단 아님인 추천만 순위순 */
  getOrCreateMatchResults(userId: string): Promise<StoredMatchResult[]>;
  profiles(userIds: string[]): Promise<ProfileRow[]>;
  /** 경로 → 만료 서명 URL */
  signPhotoUrls(paths: string[]): Promise<Map<string, string>>;
}

export class MatchingError extends Error {
  constructor(
    readonly code: MatchingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MatchingError";
  }
}

export const NICKNAME_MIN = PROFILE_LIMITS.nicknameMin;
export const NICKNAME_MAX = PROFILE_LIMITS.nicknameMax;
export const BIO_MAX = PROFILE_LIMITS.bioMax;
export const SCHOOL_FIELD_MAX = PROFILE_LIMITS.schoolFieldMax;
export const INTERESTS_MAX = PROFILE_LIMITS.interestsMax;
export const INTEREST_MAX = PROFILE_LIMITS.interestMax;
const PHOTO_FILE_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function trackFromScore(score: number): Track {
  return score > 0 ? "humanities" : "science";
}

function requireUser(userId: string | null | undefined): string {
  if (!userId) throw new MatchingError("UNAUTHENTICATED", "로그인이 필요합니다.");
  return userId;
}

function invalid(message: string): never {
  throw new MatchingError("INVALID_REQUEST", message);
}

function optionalText(value: unknown, label: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") invalid(`${label}은(는) 문자열이어야 합니다.`);
  const v = value.trim();
  if (v.length > max) invalid(`${label}은(는) ${max}자 이하입니다.`);
  return v === "" ? null : v;
}

/** HTTP 본문(unknown)을 검증해 UpdateProfileRequest 로 만든다. */
export function parseUpdateProfile(body: unknown, userId: string): UpdateProfileRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) invalid("잘못된 요청입니다.");
  const b = body as Record<string, unknown>;
  const allowed = new Set([
    "nickname", "isPublic", "track", "bio", "gender", "university", "major", "interests", "photoPath", "preferredGender",
  ]);
  for (const key of Object.keys(b)) if (!allowed.has(key)) invalid(`허용되지 않은 항목입니다: ${key}`);

  if (typeof b.nickname !== "string") invalid("닉네임을 입력해주세요.");
  const nickname = b.nickname.trim();
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    invalid(`닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자입니다.`);
  }

  if (typeof b.isPublic !== "boolean") invalid("공개 동의 여부가 필요합니다.");

  const out: UpdateProfileRequest = { nickname, isPublic: b.isPublic };

  if (b.track !== undefined) {
    if (!isTrack(b.track)) invalid("계열은 humanities 또는 science 입니다.");
    out.track = b.track;
  }

  if (b.bio !== undefined) out.bio = optionalText(b.bio, "소개", BIO_MAX) ?? "";
  const university = optionalText(b.university, "학교", SCHOOL_FIELD_MAX);
  if (university !== undefined) out.university = university;
  const major = optionalText(b.major, "전공", SCHOOL_FIELD_MAX);
  if (major !== undefined) out.major = major;

  if (b.gender !== undefined) {
    if (b.gender !== null && b.gender !== "male" && b.gender !== "female") invalid("성별 값이 올바르지 않습니다.");
    out.gender = b.gender;
  }

  if (b.preferredGender !== undefined) {
    if (b.preferredGender !== "any" && b.preferredGender !== "male" && b.preferredGender !== "female") {
      invalid("추천받을 상대 성별 값이 올바르지 않습니다.");
    }
    out.preferredGender = b.preferredGender;
  }

  if (b.interests !== undefined) {
    if (!Array.isArray(b.interests) || b.interests.length > INTERESTS_MAX) {
      invalid(`관심사는 최대 ${INTERESTS_MAX}개입니다.`);
    }
    const list: string[] = [];
    for (const item of b.interests) {
      if (typeof item !== "string") invalid("관심사는 문자열이어야 합니다.");
      const v = item.trim();
      if (!v || v.length > INTEREST_MAX) invalid(`관심사는 1~${INTEREST_MAX}자입니다.`);
      if (!list.includes(v)) list.push(v);
    }
    out.interests = list;
  }

  if (b.photoPath !== undefined) {
    if (b.photoPath === null) out.photoPath = null;
    else if (typeof b.photoPath === "string") {
      const [folder, file, ...rest] = b.photoPath.split("/");
      if (folder !== userId || !file || rest.length > 0 || !PHOTO_FILE_RE.test(file)) {
        invalid("사진 경로가 올바르지 않습니다.");
      }
      out.photoPath = b.photoPath;
    } else invalid("사진 경로가 올바르지 않습니다.");
  }

  return out;
}

/** 저장 동의 문구 버전. 문구를 바꾸면 올린다 (A 의 사주 화면 동의와 같은 값). */
export const BIRTH_STORAGE_CONSENT_VERSION = "matching_birth_storage_v1";

/**
 * A 의 사주 입력(fortuneInputSchema 로 검증된 값)에서 점수용 부분만 꺼낸다.
 * 출생 시간·성별 옵션·계산 옵션은 저장하지 않는다.
 */
export interface FortuneInputForStorage {
  birthDate: string;
  calendar: "solar" | "lunar";
  isLeapMonth: boolean;
  timezone: string;
}

export interface MatchingServiceOptions {
  /** SCORE_HMAC_SECRET. 없으면 점수 생성이 필요한 요청은 NOT_CONFIGURED */
  scoreSecret?: string;
}

export function createMatchingService(store: MatchingStore, options: MatchingServiceOptions = {}) {
  async function toCards(rows: ProfileRow[]): Promise<Map<string, ProfileCard>> {
    const paths = rows.map((r) => r.photoPath).filter((p): p is string => !!p);
    const urls = paths.length ? await store.signPhotoUrls(paths) : new Map<string, string>();
    return new Map(
      rows.map((r) => [
        r.userId,
        {
          userId: r.userId,
          nickname: r.nickname,
          gender: r.gender,
          university: r.university,
          major: r.major,
          bio: r.bio,
          interests: r.interests,
          track: r.track,
          photoUrl: r.photoPath ? (urls.get(r.photoPath) ?? null) : null,
        },
      ]),
    );
  }

  async function myCard(row: ProfileRow, preferredGender?: PreferredGender): Promise<MyProfileResponse> {
    const [cards, pref] = await Promise.all([
      toCards([row]),
      preferredGender ?? store.matchPreference(row.userId),
    ]);
    return { ...cards.get(row.userId)!, isPublic: row.isPublic, preferredGender: pref };
  }

  return {
    /** GET /api/match-results */
    async matchResults(sessionUserId: string | null): Promise<MatchResultsResponse> {
      const userId = requireUser(sessionUserId);
      if ((await store.fortuneScore(userId)) === undefined) {
        // 생년월일이 저장돼 있으면 첫 프로필 저장 때 점수가 생긴다 → 프로필 화면으로 안내
        const birth = await store.birthInput(userId);
        return { status: birth ? "profile_required" : "fortune_required", results: [] };
      }
      const me = await store.profile(userId);
      if (!me || !me.isPublic || !me.isActive) return { status: "profile_required", results: [] };

      const stored = await store.getOrCreateMatchResults(userId);
      if (stored.length === 0) return { status: "no_candidates", results: [] };

      const cards = await toCards(await store.profiles(stored.map((s) => s.targetId)));
      const results: MatchResultCard[] = [];
      for (const s of [...stored].sort((a, b) => a.rank - b.rank)) {
        const profile = cards.get(s.targetId);
        if (profile) results.push({ id: s.id, rank: s.rank, profile });
      }
      return { status: results.length ? "ready" : "no_candidates", results };
    },

    /** GET /api/profile — 프로필이 없으면 null */
    async myProfile(sessionUserId: string | null): Promise<MyProfileResponse | null> {
      const userId = requireUser(sessionUserId);
      const me = await store.profile(userId);
      return me ? myCard(me) : null;
    },

    /** GET /api/profile */
    async profileState(sessionUserId: string | null): Promise<ProfileStateResponse> {
      const userId = requireUser(sessionUserId);
      const [me, score, birth] = await Promise.all([
        store.profile(userId),
        store.fortuneScore(userId),
        store.birthInput(userId),
      ]);
      return {
        profile: me ? await myCard(me) : null,
        birthInputSaved: birth !== undefined,
        lockedTrack: score === undefined ? null : trackFromScore(score),
      };
    },

    /** PUT /api/profile — input 은 parseUpdateProfile 로 검증된 값 */
    async updateProfile(sessionUserId: string | null, input: UpdateProfileRequest): Promise<MyProfileResponse> {
      const userId = requireUser(sessionUserId);
      let score = await store.fortuneScore(userId);
      if (score === undefined) {
        const birth = await store.birthInput(userId);
        if (!birth) throw new MatchingError("FORTUNE_REQUIRED", "사주 화면에서 생년월일을 먼저 저장해주세요.");
        if (!input.track) throw new MatchingError("TRACK_REQUIRED", "문과·이과를 선택해주세요.");
        if (!options.scoreSecret) throw new MatchingError("NOT_CONFIGURED", "점수 설정을 준비하고 있어요.");
        score = await store.insertScoreIfAbsent(
          userId,
          computeScoreForBirthInput(birth, input.track, options.scoreSecret),
        );
      }
      const track = trackFromScore(score);
      if (input.track && input.track !== track) {
        throw new MatchingError("TRACK_LOCKED", "계열은 처음 저장한 뒤에는 바꿀 수 없어요.");
      }
      const prev = await store.profile(userId);
      const keep = <T>(next: T | undefined, old: T): T => (next === undefined ? old : next);
      const saved = await store.upsertProfile({
        userId,
        nickname: input.nickname,
        isPublic: input.isPublic,
        bio: keep(input.bio, prev?.bio ?? ""),
        gender: keep(input.gender, prev?.gender ?? null),
        university: keep(input.university, prev?.university ?? null),
        major: keep(input.major, prev?.major ?? null),
        interests: keep(input.interests, prev?.interests ?? []),
        photoPath: keep(input.photoPath, prev?.photoPath ?? null),
        // 계열은 저장된 점수의 부호로만 정한다
        track,
      });
      // 프로필(참조 대상)을 저장한 뒤에 저장한다
      if (input.preferredGender !== undefined) await store.saveMatchPreference(userId, input.preferredGender);
      return myCard(saved, input.preferredGender);
    },

    /**
     * A 의 사주 화면이 호출: 저장 동의를 받은 입력의 생년월일·달력·윤달·시간대를 저장한다.
     * 출생 시간은 저장하지 않는다. 점수가 이미 있으면 점수는 바뀌지 않는다 (고정 점수).
     */
    async recordBirthInput(sessionUserId: string | null, input: FortuneInputForStorage): Promise<void> {
      const userId = requireUser(sessionUserId);
      const birth: BirthInput = { calendar: input.calendar, date: input.birthDate.trim(), isLeapMonth: input.isLeapMonth };
      try {
        scoreKey(birth);
      } catch (error) {
        if (error instanceof InvalidBirthDateError) invalid(error.message);
        throw error;
      }
      const timezone = input.timezone.trim();
      if (!timezone || timezone.length > 80) invalid("출생지 시간대를 확인해주세요.");
      await store.saveBirthInput({ ...birth, userId, timezone, consentVersion: BIRTH_STORAGE_CONSENT_VERSION });
    },

    /**
     * A 의 calculateFortuneForMatching 결과(status = ready)를 저장한다.
     * 점수·추천 자격과는 별개이며, 본인 결과만 저장한다.
     */
    async recordMatchingAnalysis(
      sessionUserId: string | null,
      dto: Omit<FortuneAnalysisWrite, "userId"> & { userId: string; status: "ready" },
    ): Promise<void> {
      const userId = requireUser(sessionUserId);
      if (dto.status !== "ready" || dto.userId !== userId) invalid("본인의 준비된 분석만 저장할 수 있습니다.");
      await store.saveFortuneAnalysis({
        userId,
        schemaVersion: dto.schemaVersion,
        chartBasis: dto.chartBasis,
        provider: dto.provider,
        adapterVersion: dto.adapterVersion,
        fortuneSchemaVersion: dto.fortuneSchemaVersion,
        inputFingerprint: dto.inputFingerprint,
        comparisonKey: dto.comparisonKey,
        calculatedAt: dto.calculatedAt,
        chart: dto.chart,
        calculation: dto.calculation,
        analysis: dto.analysis,
      });
    },
  };
}

export type MatchingService = ReturnType<typeof createMatchingService>;
