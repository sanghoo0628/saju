/**
 * B 담당 서버 로직: 프로필 등록·수정, 무료 추천 조회.
 * 서버 전용. 저장소는 주입한다 (운영: supabase-store.ts, 테스트: 메모리 구현).
 * userId 는 반드시 A 의 서버 세션에서 가져온다. 요청 본문의 사용자 ID 를 믿지 않는다.
 */
import type {
  Gender,
  MatchingErrorCode,
  MatchResultCard,
  MatchResultsResponse,
  MyProfileResponse,
  ProfileCard,
  UpdateProfileRequest,
} from "../contracts/matching";
import type { Track } from "../lib/score";

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

export interface MatchingStore {
  profile(userId: string): Promise<ProfileRow | undefined>;
  /** fortune_results.score (없으면 undefined) */
  fortuneScore(userId: string): Promise<number | undefined>;
  upsertProfile(row: ProfileWrite): Promise<ProfileRow>;
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

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 20;
export const BIO_MAX = 300;
export const SCHOOL_FIELD_MAX = 50;
export const INTERESTS_MAX = 10;
export const INTEREST_MAX = 20;
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
  const allowed = new Set(["nickname", "isPublic", "bio", "gender", "university", "major", "interests", "photoPath"]);
  for (const key of Object.keys(b)) if (!allowed.has(key)) invalid(`허용되지 않은 항목입니다: ${key}`);

  if (typeof b.nickname !== "string") invalid("닉네임을 입력해주세요.");
  const nickname = b.nickname.trim();
  if (nickname.length < NICKNAME_MIN || nickname.length > NICKNAME_MAX) {
    invalid(`닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자입니다.`);
  }

  if (typeof b.isPublic !== "boolean") invalid("공개 동의 여부가 필요합니다.");

  const out: UpdateProfileRequest = { nickname, isPublic: b.isPublic };

  if (b.bio !== undefined) out.bio = optionalText(b.bio, "소개", BIO_MAX) ?? "";
  const university = optionalText(b.university, "학교", SCHOOL_FIELD_MAX);
  if (university !== undefined) out.university = university;
  const major = optionalText(b.major, "전공", SCHOOL_FIELD_MAX);
  if (major !== undefined) out.major = major;

  if (b.gender !== undefined) {
    if (b.gender !== null && b.gender !== "male" && b.gender !== "female") invalid("성별 값이 올바르지 않습니다.");
    out.gender = b.gender;
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

export function createMatchingService(store: MatchingStore) {
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

  async function myCard(row: ProfileRow): Promise<MyProfileResponse> {
    const card = (await toCards([row])).get(row.userId)!;
    return { ...card, isPublic: row.isPublic };
  }

  return {
    /** GET /api/match-results */
    async matchResults(sessionUserId: string | null): Promise<MatchResultsResponse> {
      const userId = requireUser(sessionUserId);
      if ((await store.fortuneScore(userId)) === undefined) return { status: "fortune_required", results: [] };
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

    /** PUT /api/profile — input 은 parseUpdateProfile 로 검증된 값 */
    async updateProfile(sessionUserId: string | null, input: UpdateProfileRequest): Promise<MyProfileResponse> {
      const userId = requireUser(sessionUserId);
      const score = await store.fortuneScore(userId);
      if (score === undefined) throw new MatchingError("FORTUNE_REQUIRED", "사주 결과를 먼저 확인해주세요.");
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
        track: trackFromScore(score),
      });
      return myCard(saved);
    },
  };
}

export type MatchingService = ReturnType<typeof createMatchingService>;
