/**
 * MatchingStore 의 Supabase 구현. 서버 전용 (service_role 클라이언트를 주입).
 * service_role 은 RLS 를 우회하므로 사용자 ID 는 항상 서버 세션에서 온 값만 넘긴다.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Gender } from "../contracts/matching";
import type { Track } from "../lib/score";
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
  return {
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
}
