/**
 * 고정 점수 생성 (개발 계획 2장).
 *
 * - 기본 숫자 = 1 + (HMAC-SHA256(secret, "YYYY-MM-DD") 를 정수로 변환한 값 mod 10,000)
 * - 문과 점수 = +기본 숫자, 이과 점수 = −기본 숫자
 *
 * 점수는 실제 사주 계산과 별개인 오락용 매칭 규칙이다.
 * 서버 전용 모듈: 비밀 키를 브라우저로 보내지 않는다.
 * 계산 결과는 fortune_results 에 score_version 과 함께 저장하고,
 * 이후에는 저장된 점수를 우선 사용한다 (비밀 키가 바뀌어도 기존 점수 유지).
 */
import { createHmac } from "node:crypto";

/** 계산 규칙이 바뀌면 올린다. fortune_results.score_version 에 저장. */
export const SCORE_VERSION = 1;

export const BASE_NUMBER_MIN = 1;
export const BASE_NUMBER_MAX = 10_000;

/** 문과 / 이과. DB enum public.track 과 같은 값. */
export const TRACKS = ["humanities", "science"] as const;
export type Track = (typeof TRACKS)[number];

export function isTrack(value: unknown): value is Track {
  return typeof value === "string" && (TRACKS as readonly string[]).includes(value);
}

const BIRTH_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 생년월일을 "YYYY-MM-DD" 하나의 형식으로 검증한다.
 * 형식이 다르거나 존재하지 않는 날짜(2001-02-30 등), 범위 밖 연도는 거부한다.
 * 같은 날짜가 다른 문자열로 해시되지 않도록 다른 형식을 자동 변환하지 않는다.
 */
export function normalizeBirthDate(input: string, today: Date = new Date()): string {
  const value = input.trim();
  const m = BIRTH_DATE_RE.exec(value);
  if (!m) throw new InvalidBirthDateError("생년월일은 YYYY-MM-DD 형식이어야 합니다.");
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidBirthDateError("존재하지 않는 날짜입니다.");
  }
  if (year < 1900) throw new InvalidBirthDateError("1900년 이후 날짜만 입력할 수 있습니다.");
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (date.getTime() > todayUtc) throw new InvalidBirthDateError("미래 날짜는 입력할 수 없습니다.");
  return value;
}

export class InvalidBirthDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBirthDateError";
  }
}

function baseNumberFromKey(key: string, secret: string): number {
  if (!secret) throw new Error("SCORE_HMAC_SECRET 이 설정되지 않았습니다.");
  const digest = createHmac("sha256", secret).update(key, "utf8").digest("hex");
  // 256비트 전체를 정수로 변환. mod 10,000 의 편향은 무시할 수 있는 수준.
  const n = BigInt(`0x${digest}`) % BigInt(BASE_NUMBER_MAX);
  return BASE_NUMBER_MIN + Number(n);
}

/** 생년월일 → 기본 숫자(1~10,000). 같은 생년월일·같은 키면 항상 같은 값. */
export function computeBaseNumber(birthDate: string, secret: string): number {
  return baseNumberFromKey(normalizeBirthDate(birthDate), secret);
}

/**
 * 음력 생일을 "YYYY-MM-DD" 로 검증한다 (월 1~12, 일 1~30, 1900년~올해).
 * 음력은 양력 Date 로 해석하지 않는다. 실제 윤달 존재 여부·양력 변환은 사주 공급자 몫이다.
 */
export function normalizeLunarDate(input: string, today: Date = new Date()): string {
  const value = input.trim();
  const m = BIRTH_DATE_RE.exec(value);
  if (!m) throw new InvalidBirthDateError("생년월일은 YYYY-MM-DD 형식이어야 합니다.");
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > today.getUTCFullYear()) throw new InvalidBirthDateError("생년월일 범위를 확인해주세요.");
  if (month < 1 || month > 12 || day < 1 || day > 30) throw new InvalidBirthDateError("음력 날짜는 1~12월, 1~30일입니다.");
  return value;
}

/** A 의 사주 입력에서 점수에 쓰는 부분. 출생 시간·시간대는 점수에 쓰지 않는다. */
export interface BirthInput {
  calendar: "solar" | "lunar";
  /** 입력한 달력 기준의 YYYY-MM-DD (음력이면 음력 날짜 그대로) */
  date: string;
  isLeapMonth: boolean;
}

/** fortune_results.score_input 에 저장. 어떤 키로 해시했는지 기록한다. */
export type ScoreInput = "solar" | "lunar" | "lunar_leap";

/**
 * 해시 키. 양력은 기존 v1 그대로 "YYYY-MM-DD".
 * 음력은 양력으로 변환하지 않고 "lunar:YYYY-MM-DD" / "lunar-leap:YYYY-MM-DD" 를 쓴다.
 * (같은 사람이 양력·음력으로 각각 입력하면 점수가 다를 수 있다. 저장된 점수가 우선이다.)
 */
export function scoreKey(input: BirthInput): { key: string; scoreInput: ScoreInput } {
  if (input.calendar === "solar") {
    if (input.isLeapMonth) throw new InvalidBirthDateError("윤달은 음력에만 적용됩니다.");
    return { key: normalizeBirthDate(input.date), scoreInput: "solar" };
  }
  const date = normalizeLunarDate(input.date);
  return input.isLeapMonth
    ? { key: `lunar-leap:${date}`, scoreInput: "lunar_leap" }
    : { key: `lunar:${date}`, scoreInput: "lunar" };
}

/** 기본 숫자 + 계열 → 점수. 문과 양수, 이과 음수. */
export function toScore(baseNumber: number, track: Track): number {
  if (!Number.isInteger(baseNumber) || baseNumber < BASE_NUMBER_MIN || baseNumber > BASE_NUMBER_MAX) {
    throw new RangeError(`기본 숫자는 ${BASE_NUMBER_MIN}~${BASE_NUMBER_MAX} 정수여야 합니다.`);
  }
  return track === "humanities" ? baseNumber : -baseNumber;
}

export interface ComputedScore {
  baseNumber: number;
  score: number;
  scoreVersion: number;
}

export interface ComputedBirthScore extends ComputedScore {
  scoreInput: ScoreInput;
}

/** 생년월일·계열 → 저장할 점수 묶음. */
export function computeScore(birthDate: string, track: Track, secret: string): ComputedScore {
  const baseNumber = computeBaseNumber(birthDate, secret);
  return { baseNumber, score: toScore(baseNumber, track), scoreVersion: SCORE_VERSION };
}

/** 저장된 사주 입력(양력·음력)·계열 → 저장할 점수 묶음. 양력 결과는 computeScore 와 같다. */
export function computeScoreForBirthInput(input: BirthInput, track: Track, secret: string): ComputedBirthScore {
  const { key, scoreInput } = scoreKey(input);
  const baseNumber = baseNumberFromKey(key, secret);
  return { baseNumber, score: toScore(baseNumber, track), scoreVersion: SCORE_VERSION, scoreInput };
}
