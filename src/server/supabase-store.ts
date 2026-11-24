/**
 * MatchingStore 의 Supabase 구현. 서버 전용 (service_role 클라이언트를 주입).
 * service_role 은 RLS 를 우회하므로 사용자 ID 는 항상 서버 세션에서 온 값만 넘긴다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Gender, PreferredGender } from "../contracts/matching";
import type { BirthInput, Track } from "../lib/score";
import type { MatchingStore, ProfileRow, StoredMatchResult } from "./matching-service";

export const PROFILE_PHOTO_BUCKET = "profile-photos";
/** 서명 URL 유효 시간(초) */
export const PHOTO_URL_TTL_SECONDS = 600;

interface ProfileDbRow {
  id: string;
  nickname: string;
  gender: Gender | null;
  university: string | null;
  major: string | null;
  bio: string;
  interests: string[];
  track: Track;
  photo_path: string | null;
  is_public: boolean;
  status: "active" | "deleted";
}

const PROFILE_COLUMNS = "id, nickname, gender, university, major, bio, interests, track, photo_path, is_public, status";

function toProfile(r: ProfileDbRow): ProfileRow {
  return {
    userId: r.id,
    nickname: r.nickname,
    gender: r.gender,
    university: r.university,
    major: r.major,
    bio: r.bio,
    interests: r.interests,
    track: r.track,
    photoPath: r.photo_path,
    isPublic: r.is_public,
    isActive: r.status === "active",
  };
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} 실패: ${res.error.message}`);
  return res.data;
}

export function createSupabaseMatchingStore(admin: SupabaseClient): MatchingStore {
  const store: MatchingStore = {
    async profile(userId) {
      const data = check(
        await admin.from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle<ProfileDbRow>(),
        "프로필 조회",
      );
      return data ? toProfile(data) : undefined;
    },

    async fortuneScore(userId) {
      const data = check(
        await admin.from("fortune_results").select("score").eq("user_id", userId).maybeSingle<{ score: number }>(),
        "점수 조회",
      );
      return data?.score;
    },

    async birthInput(userId) {
      const data = check(
        await admin
          .from("private_birth_data")
          .select("birth_date, lunar_date, calendar_type, is_leap_month")
          .eq("user_id", userId)
          .maybeSingle<{ birth_date: string | null; lunar_date: string | null; calendar_type: "solar" | "lunar"; is_leap_month: boolean }>(),
        "생년월일 조회",
      );
      if (!data) return undefined;
      const date = data.calendar_type === "solar" ? data.birth_date : data.lunar_date;
      if (!date) return undefined;
      return { calendar: data.calendar_type, date, isLeapMonth: data.is_leap_month } satisfies BirthInput;
    },

    async saveBirthInput(row) {
      const now = new Date().toISOString();
      check(
        await admin.from("private_birth_data").upsert(
          {
            user_id: row.userId,
            calendar_type: row.calendar,
            birth_date: row.calendar === "solar" ? row.date : null,
            lunar_date: row.calendar === "lunar" ? row.date : null,
            is_leap_month: row.isLeapMonth,
            birth_time: null,
            timezone: row.timezone,
            consent_version: row.consentVersion,
            consented_at: now,
          },
          { onConflict: "user_id" },
        ),
        "생년월일 저장",
      );
    },

    async insertScoreIfAbsent(userId, s) {
      check(
        await admin.from("fortune_results").upsert(
          {
            user_id: userId,
            base_number: s.baseNumber,
            score: s.score,
            score_version: s.scoreVersion,
            score_input: s.scoreInput,
          },
          { onConflict: "user_id", ignoreDuplicates: true },
        ),
        "점수 저장",
      );
      const stored = await store.fortuneScore(userId);
      if (stored === undefined) throw new Error("점수 저장 실패: 결과 없음");
      return stored;
    },

    async saveFortuneAnalysis(row) {
      check(
        await admin.from("fortune_analyses").upsert(
          {
            user_id: row.userId,
            schema_version: row.schemaVersion,
            chart_basis: row.chartBasis,
            provider: row.provider,
            adapter_version: row.adapterVersion,
            fortune_schema_version: row.fortuneSchemaVersion,
            input_fingerprint: row.inputFingerprint,
            comparison_key: row.comparisonKey,
            calculated_at: row.calculatedAt,
            chart: row.chart,
            calculation: row.calculation,
            analysis: row.analysis,
          },
          { onConflict: "user_id" },
        ),
        "사주 분석 저장",
      );
    },

    async upsertProfile(row) {
      const data = check(
        await admin
          .from("profiles")
          .upsert(
            {
              id: row.userId,
              nickname: row.nickname,
              gender: row.gender,
              university: row.university,
              major: row.major,
              bio: row.bio,
              interests: row.interests,
              track: row.track,
              photo_path: row.photoPath,
              is_public: row.isPublic,
            },
            { onConflict: "id" },
          )
          .select(PROFILE_COLUMNS)
          .single<ProfileDbRow>(),
        "프로필 저장",
      );
      if (!data) throw new Error("프로필 저장 실패: 결과 없음");
      return toProfile(data);
    },

    async matchPreference(userId) {
      const data = check(
        await admin
          .from("match_preferences")
          .select("preferred_gender")
          .eq("user_id", userId)
          .maybeSingle<{ preferred_gender: PreferredGender }>(),
        "추천 조건 조회",
      );
      return data?.preferred_gender ?? "any";
    },

    async saveMatchPreference(userId, preferredGender) {
      check(
        await admin
          .from("match_preferences")
          .upsert({ user_id: userId, preferred_gender: preferredGender }, { onConflict: "user_id" }),
        "추천 조건 저장",
      );
    },

    async getOrCreateMatchResults(userId) {
      const data = check(
        await admin.rpc("get_or_create_match_results", { p_user: userId }),
        "추천 생성",
      ) as { id: string; target_id: string; rank: number }[] | null;
      return (data ?? []).map((r): StoredMatchResult => ({ id: r.id, targetId: r.target_id, rank: r.rank }));
    },

    async profiles(userIds) {
      if (userIds.length === 0) return [];
      const data = check(
        await admin.from("profiles").select(PROFILE_COLUMNS).in("id", userIds).returns<ProfileDbRow[]>(),
        "프로필 목록 조회",
      );
      return (data ?? []).map(toProfile);
    },

    async signPhotoUrls(paths) {
      const data = check(
        await admin.storage.from(PROFILE_PHOTO_BUCKET).createSignedUrls(paths, PHOTO_URL_TTL_SECONDS),
        "사진 URL 생성",
      );
      const out = new Map<string, string>();
      for (const item of data ?? []) {
        if (item.path && item.signedUrl && !item.error) out.set(item.path, item.signedUrl);
      }
      return out;
    },
  };
  return store;
}
