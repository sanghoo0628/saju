/**
 * B 담당 프로필·무료 추천 API 계약.
 * 프레임워크에 의존하지 않는 타입. C 의 contracts/payment-chat.ts 와 같은 방식으로 공유한다.
 * (C 브랜치와 합칠 때 루트 contracts/matching.ts 로 옮긴다)
 *
 * 과금 흐름: 무료 추천 3명 공개 → 상대 선택(matchResultId) → C 의 POST /api/orders (상대당 500원)
 */
import type { Track } from "../lib/score";

export type Gender = "male" | "female";

/**
 * 다른 사용자에게 보여주는 프로필 카드.
 * 생년월일·출생 시간·출생지·학교 이메일·점수·사주 원문은 포함하지 않는다.
 */
export interface ProfileCard {
  userId: string;
  nickname: string;
  gender: Gender | null;
  university: string | null;
  major: string | null;
  bio: string;
  interests: string[];
  track: Track;
  /** 만료되는 서명 URL. 사진이 없으면 null */
  photoUrl: string | null;
}

/**
 * GET /api/match-results — 로그인 필요, 결제 불필요.
 * 첫 호출 시 거리순 상위 3명을 저장하고, 이후에는 저장된 같은 결과를 반환한다.
 * C 는 results[].id 를 CreateOrderRequest.matchResultId 로 사용한다.
 */
export interface MatchResultsResponse {
  /**
   * ready: 추천 있음(1~3명)
   * fortune_required: 매칭용 생년월일이 저장되지 않음 → 사주 화면
   * profile_required: 프로필 미등록(점수는 첫 프로필 저장 때 생성) 또는 공개 미동의 → 프로필 화면
   * no_candidates: 조건에 맞는 후보 없음
   */
  status: "ready" | "fortune_required" | "profile_required" | "no_candidates";
  results: MatchResultCard[];
}

export interface MatchResultCard {
  /** match_results.id = C 의 MatchResult.id / CreateOrderRequest.matchResultId */
  id: string;
  rank: number;
  profile: ProfileCard;
}

/**
 * PUT /api/profile — 로그인 필요. 프로필 생성·수정.
 * 계열(track): 점수가 아직 없으면 필수. 서버가 저장된 사주 입력 + 계열로 고정 점수를 만든다.
 * 점수가 생긴 뒤에는 저장된 점수의 부호(문과 +, 이과 −)가 계열이며 바꿀 수 없다 (다른 값이면 TRACK_LOCKED).
 * 사진은 브라우저가 profile-photos 버킷의 "{userId}/파일명" 에 올린 뒤 그 경로를 보낸다.
 * 생략한 선택 항목은 기존 값을 유지한다.
 */
export interface UpdateProfileRequest {
  nickname: string;
  /** 첫 등록(점수 없음) 때 필수. 이후에는 생략하거나 같은 값만 허용 */
  track?: Track;
  /** 매칭 후보 공개 동의 */
  isPublic: boolean;
  bio?: string;
  gender?: Gender | null;
  university?: string | null;
  major?: string | null;
  interests?: string[];
  /** null 이면 사진 삭제 */
  photoPath?: string | null;
}

/** PUT /api/profile 응답, ProfileStateResponse.profile */
export interface MyProfileResponse extends ProfileCard {
  isPublic: boolean;
}

/**
 * GET /api/profile — 프로필 화면이 다음 단계를 정하는 데 필요한 상태.
 * 생년월일·점수 숫자는 내려주지 않는다.
 */
export interface ProfileStateResponse {
  /** 프로필이 없으면 null */
  profile: MyProfileResponse | null;
  /** 사주 화면에서 매칭용 생년월일 저장이 끝났는지 */
  birthInputSaved: boolean;
  /** 고정 점수가 있으면 그 계열(변경 불가). 없으면 null → 첫 저장 때 track 필요 */
  lockedTrack: Track | null;
}

export type MatchingErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST"
  | "FORTUNE_REQUIRED"
  | "TRACK_REQUIRED"
  | "TRACK_LOCKED"
  | "NOT_CONFIGURED";

/** 프로필 입력 제한. 서버 검증(parseUpdateProfile)과 화면이 같은 값을 쓴다. */
export const PROFILE_LIMITS = {
  nicknameMin: 2,
  nicknameMax: 20,
  bioMax: 300,
  schoolFieldMax: 50,
  interestsMax: 10,
  interestMax: 20,
} as const;

/** 프로필 사진: profile-photos 버킷 제한과 같은 값 */
export const PROFILE_PHOTO_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: ["image/jpeg", "image/png", "image/webp"],
} as const;
