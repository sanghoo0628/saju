import type { MatchingModelId, UserId } from "./product";

/** A's original view projection, not B's ProfileCard wire contract.
 * B's authoritative fields use track, not academicTrack; adapt explicitly at the UI.
 * See docs/A_BC_INTEGRATION_DESIGN.md. Never cast a B DB row to this type.
 */
export interface PublicProfileDto {
  userId: UserId;
  nickname: string;
  bio: string;
  academicTrack: "humanities" | "science" | "other" | "undisclosed";
  /** A short-lived authorized photo URL, never a raw private storage path. */
  photoUrl: string | null;
}

/** Explicit projection: do not spread DB rows into public responses. */
export function toPublicProfileDto(profile: PublicProfileDto): PublicProfileDto {
  return {
    userId: profile.userId,
    nickname: profile.nickname,
    bio: profile.bio,
    academicTrack: profile.academicTrack,
    photoUrl: profile.photoUrl,
  };
}

export interface RecommendationCardDto {
  recommendationId: string;
  rank: 1 | 2 | 3;
  profile: PublicProfileDto;
  modelId: MatchingModelId;
  modelVersion: string;
  reasons: readonly string[];
  limitations: readonly string[];
}

/** @deprecated Original A proposal only; do not expose as B's API response.
 * B uses GET /api/match-results with {status, results:[{id,rank,profile}]}.
 * Its current 1–3 result policy and the product's 3-person promise need explicit
 * reconciliation, not a tuple cast or invented profiles. No runtime uses this yet.
 */
export type RecommendationResponse =
  | {
      status: "ready";
      batchId: string;
      priceKrw: 0;
      recommendations: readonly [
        RecommendationCardDto,
        RecommendationCardDto,
        RecommendationCardDto,
      ];
    }
  | { status: "not_ready"; code: "MATCHING_NOT_READY" | "INSUFFICIENT_CANDIDATES" };
