import type { FortuneProvider } from "../types";

export function createUnconfiguredFortuneProvider(id = "external"): FortuneProvider {
  return {
    id,
    version: "unconfigured",
    mode: "provider",
    async calculate() {
      return {
        status: "not_ready",
        reasonCode: "PROVIDER_NOT_CONFIGURED",
        message: "실제 사주 공급자의 입력·응답 계약과 연결 설정을 준비하고 있습니다.",
      };
    },
  };
}
