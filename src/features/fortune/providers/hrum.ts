import "server-only";
import type { FortuneInput } from "../schema";
import type { FortuneErrorCode, FortuneProvider, ProviderResult } from "../types";
import { normalizeHrumResponse } from "./hrum-normalize";

const endpoint = "https://api.hrum.ai/api/v1/partners/v1/manseryeok";
const maxResponseBytes = 2 * 1024 * 1024;

function failure(code: FortuneErrorCode, retryable = false): ProviderResult {
  return { status: "error", code, retryable, message: "사주 공급자의 요청 또는 결과를 확인하지 못했습니다." };
}

function unsupported(): ProviderResult {
  return {
    status: "not_ready",
    reasonCode: "PROVIDER_INPUT_UNSUPPORTED",
    message: "현재 사주 공급자가 지원하는 성별·날짜 경계 옵션을 선택해 주세요.",
  };
}

/** Only documented calculation fields leave our server. No owner ID, consent, or name is sent. */
function requestBody(input: FortuneInput) {
  const [year, month, day] = input.birthDate.split("-").map(Number);
  const time = input.birthTime === null ? null : input.birthTime.split(":").map(Number);
  return {
    year, month, day,
    ...(time ? { hour: time[0], minute: time[1] } : {}),
    timezone: input.timezone,
    gender: input.providerSex,
    calendar: input.calendar,
    isLeapMonth: input.isLeapMonth,
    lang: "ko",
    zaSiRule: input.calculationOptions.dayBoundary === "civil_midnight" ? "yajaSi" : "traditional",
    // Omitting location/country disables true-solar correction. Unknown time never gets a default hour.
    birthTimePrecision: time ? "exact" : "unknown",
  };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel();
    throw new Error("Invalid provider response");
  }
  if (!response.body) throw new Error("Invalid provider response");
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      if (signal.aborted) throw new Error("Provider request aborted");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Provider request aborted");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error("Invalid provider response");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function createHrumFortuneProvider({ apiKey, fetcher = fetch }: {
  apiKey: string;
  fetcher?: typeof fetch;
}): FortuneProvider {
  return {
    id: "hrum",
    // This pins our adapter contract snapshot; HRUM does not expose a manseryeok engine version.
    version: "hrum_adapter_2026_11_16_v1",
    mode: "provider",
    async calculate(input, { signal }) {
      if (input.externalProviderConsent !== "hrum_birth_data_v1") {
        return { status: "not_ready", reasonCode: "EXTERNAL_CONSENT_REQUIRED", message: "HRUM으로 사주 계산 입력을 전송하는 데 동의해 주세요." };
      }
      if (input.providerSex === "unspecified" || input.calculationOptions.dayBoundary === "late_zi") return unsupported();
      if (!apiKey.trim()) {
        return { status: "not_ready", reasonCode: "PROVIDER_NOT_CONFIGURED", message: "사주 공급자 연결 설정이 필요합니다." };
      }
      if (signal.aborted) return failure("PROVIDER_TIMEOUT", true);
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Partner-Api-Key": apiKey,
            "User-Agent": "sai-campus/0.1.0",
          },
          body: JSON.stringify(requestBody(input)),
          signal,
          cache: "no-store",
          redirect: "error",
        });
      } catch {
        return failure(signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE", true);
      }
      if (!response.ok) {
        // Never expose provider error bodies (including WAF HTML) or retry a potentially billed call here.
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) return failure("PROVIDER_AUTH_FAILED");
        if (response.status === 402) return failure("PROVIDER_QUOTA_EXCEEDED");
        if (response.status === 429) return failure("PROVIDER_RATE_LIMITED", true);
        if (response.status === 400) return failure("PROVIDER_INPUT_REJECTED");
        return failure("PROVIDER_UNAVAILABLE", response.status >= 500);
      }
      try {
        const payload = await readBoundedJson(response, signal);
        const data = normalizeHrumResponse(payload, input);
        return { status: "ready", data };
      } catch {
        return failure(signal.aborted ? "PROVIDER_TIMEOUT" : "INVALID_PROVIDER_RESPONSE", signal.aborted);
      }
    },
  };
}
