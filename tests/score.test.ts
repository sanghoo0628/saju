import { describe, expect, it } from "vitest";
import {
  computeBaseNumber,
  computeScore,
  computeScoreForBirthInput,
  normalizeLunarDate,
  scoreKey,
  InvalidBirthDateError,
  normalizeBirthDate,
  SCORE_VERSION,
  toScore,
} from "../src/lib/score";

const SECRET = "test-secret";

describe("normalizeBirthDate", () => {
  it("YYYY-MM-DD 를 그대로 통과시킨다", () => {
    expect(normalizeBirthDate(" 2003-05-17 ")).toBe("2003-05-17");
  });

  it.each(["2003-5-17", "2003/05/17", "20030517", "17-05-2003", ""])("다른 형식 %s 은 거부한다", (v) => {
    expect(() => normalizeBirthDate(v)).toThrow(InvalidBirthDateError);
  });

  it("존재하지 않는 날짜를 거부한다", () => {
    expect(() => normalizeBirthDate("2003-02-29")).toThrow(InvalidBirthDateError);
    expect(() => normalizeBirthDate("2003-13-01")).toThrow(InvalidBirthDateError);
    expect(normalizeBirthDate("2004-02-29")).toBe("2004-02-29"); // 윤년
  });

  it("미래 날짜와 1900년 이전을 거부한다", () => {
    const today = new Date("2026-11-16T00:00:00Z");
    expect(() => normalizeBirthDate("2026-11-17", today)).toThrow(InvalidBirthDateError);
    expect(normalizeBirthDate("2026-11-16", today)).toBe("2026-11-16");
    expect(() => normalizeBirthDate("1899-12-31", today)).toThrow(InvalidBirthDateError);
  });
});

describe("computeBaseNumber", () => {
  it("같은 생년월일·같은 키면 항상 같은 값", () => {
    const a = computeBaseNumber("2003-05-17", SECRET);
    expect(computeBaseNumber("2003-05-17", SECRET)).toBe(a);
  });

  it("알려진 값과 일치한다 (계산 규칙 변경 감지용)", () => {
    // 1 + (HMAC-SHA256("test-secret", "2003-05-17") as uint256 mod 10000)
    expect(computeBaseNumber("2003-05-17", SECRET)).toBe(8352);
  });

  it("키가 다르면 대체로 다른 값", () => {
    const dates = ["2001-01-01", "2002-02-02", "2003-03-03", "2004-04-04", "2005-05-05"];
    const diff = dates.filter((d) => computeBaseNumber(d, "k1") !== computeBaseNumber(d, "k2"));
    expect(diff.length).toBeGreaterThan(0);
  });

  it("항상 1~10,000 범위의 정수", () => {
    const start = Date.UTC(1990, 0, 1);
    for (let i = 0; i < 5000; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      const n = computeBaseNumber(d, SECRET);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(10_000);
    }
  });

  it("비밀 키가 없으면 실패한다", () => {
    expect(() => computeBaseNumber("2003-05-17", "")).toThrow();
  });
});

describe("toScore / computeScore", () => {
  it("문과는 양수, 이과는 음수", () => {
    expect(toScore(3500, "humanities")).toBe(3500);
    expect(toScore(3500, "science")).toBe(-3500);
  });

  it("범위 밖 기본 숫자는 거부한다", () => {
    expect(() => toScore(0, "humanities")).toThrow(RangeError);
    expect(() => toScore(10_001, "science")).toThrow(RangeError);
    expect(() => toScore(1.5, "science")).toThrow(RangeError);
  });

  it("같은 생년월일의 문과·이과 점수는 부호만 다르다", () => {
    const h = computeScore("2003-05-17", "humanities", SECRET);
    const s = computeScore("2003-05-17", "science", SECRET);
    expect(h.score).toBe(-s.score);
    expect(h.baseNumber).toBe(s.baseNumber);
    expect(h.scoreVersion).toBe(SCORE_VERSION);
  });
});

describe("음력 입력과 점수 키 (2026-11-23 A 저장 계약)", () => {
  it("양력 입력은 기존 v1 과 같은 점수", () => {
    const solar = computeScoreForBirthInput({ calendar: "solar", date: "2003-05-17", isLeapMonth: false }, "humanities", "test-secret");
    expect(solar).toEqual({ ...computeScore("2003-05-17", "humanities", "test-secret"), scoreInput: "solar", birthKey: "2003-05-17" });
  });

  it("음력·윤달은 다른 키로 해시하고 입력 종류를 기록한다", () => {
    expect(scoreKey({ calendar: "lunar", date: "2001-02-30", isLeapMonth: false })).toEqual({ key: "lunar:2001-02-30", scoreInput: "lunar" });
    expect(scoreKey({ calendar: "lunar", date: "2001-02-30", isLeapMonth: true })).toEqual({ key: "lunar-leap:2001-02-30", scoreInput: "lunar_leap" });
    const a = computeScoreForBirthInput({ calendar: "lunar", date: "2003-05-17", isLeapMonth: false }, "science", "test-secret");
    const b = computeScoreForBirthInput({ calendar: "lunar", date: "2003-05-17", isLeapMonth: true }, "science", "test-secret");
    expect(a.scoreInput).toBe("lunar");
    expect(b.scoreInput).toBe("lunar_leap");
    expect(a.score).toBeLessThan(0);
    expect(a.baseNumber).not.toBe(b.baseNumber);
  });

  it.each(["2001-13-01", "2001-00-10", "2001-02-31", "1899-01-01", "2001-2-3", "abcd-ef-gh"])("음력 거부: %s", (date) => {
    expect(() => normalizeLunarDate(date, new Date("2026-11-23T00:00:00Z"))).toThrow(InvalidBirthDateError);
  });

  it("양력 윤달은 거부", () => {
    expect(() => scoreKey({ calendar: "solar", date: "2003-05-17", isLeapMonth: true })).toThrow(InvalidBirthDateError);
  });
});
