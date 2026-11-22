import type { FortuneProvider } from "../types";
import type { NormalizedChart } from "../normalization";

/** Explicit fixed fixture. It never claims to calculate a person's actual chart. */
export function createMockFortuneProvider(): FortuneProvider {
  return {
    id: "development_mock",
    version: "fixed_fixture_v1",
    mode: "mock",
    async calculate(input) {
      const data: NormalizedChart = {
        chartBasis: input.birthTime === null ? "three_pillars" : "four_pillars",
        calculation: { profileId: 'mock_fixture_v2', dayBoundary: 'mock', timeCorrection: 'mock', timezone: input.timezone },
        chart: {
          year: { stem: "gap", branch: "ja" },
          month: { stem: "byeong", branch: "in" },
          day: { stem: "mu", branch: "jin" },
          hour: input.birthTime === null ? null : { stem: "im", branch: "ja" },
        },
        analysis: { elementBalance: null, yongshin: null, strength: null },
        interpretation: {
          title: "개발용 사주 결과 샘플",
          paragraphs: [
            "이 화면은 입력부터 결과까지 연결을 확인하는 고정 샘플입니다. 입력한 생년월일로 계산한 실제 사주가 아닙니다.",
            input.birthTime === null
              ? "출생 시간을 모르는 입력은 시주를 만들지 않고 년·월·일의 3주 구조로 전달합니다."
              : "출생 시간을 아는 입력은 4주 상세 결과 구조를 확인합니다. 추천에 사용할 공통 3주 분석은 별도 계산이 필요합니다.",
            "실제 풀이와 추천 점수는 공급자 연결 및 승인된 매칭 규칙이 준비된 뒤 제공됩니다.",
          ],
        },
        limitations: [
          "실제 사주 계산·성격 분석·궁합 점수가 아닙니다.",
          "오행·용신·강약 값은 계산하지 않았습니다.",
          ...(input.birthTime === null ? ["출생 시간 미상: 시주를 임의로 채우지 않았습니다."] : []),
          ...(input.calendar === "lunar" ? ["음력 날짜·윤달의 실제 존재 여부와 양력 변환은 공급자 연결 후 검증합니다."] : []),
        ],
      };
      return { status: "ready", data };
    },
  };
}
