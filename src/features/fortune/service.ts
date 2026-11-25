import "server-only";
import { createHmac } from "node:crypto";
import { fortuneInputSchema, type FortuneInput } from "./schema";
import { normalizedChartSchema } from "./normalization";
import type { FortuneCache, FortuneErrorCode, FortuneProvider, FortuneResult, ProviderResult } from "./types";
import type { ClaimProviderCall } from "./quota";

export interface CalculateFortuneOptions {
  userId: string;
  provider: FortuneProvider;
  fingerprintSecret: string;
  cache?: FortuneCache;
  timeoutMs?: number;
  now?: () => Date;
  /** Daily quota claim for billed provider calls. Shared by every fortune route via getFortuneServiceOptions. */
  claimProviderCall?: ClaimProviderCall;
}

export function createFortuneFingerprint(input: FortuneInput, options: Pick<CalculateFortuneOptions, "userId" | "provider" | "fingerprintSecret">): string {
  if (options.fingerprintSecret.length < 32) throw new Error("Fortune fingerprint secret requires at least 32 characters.");
  if (!options.userId) throw new Error("A verified user ID is required.");
  const canonical = JSON.stringify({
    userId: options.userId,
    provider: options.provider.id,
    providerVersion: options.provider.version,
    mode: options.provider.mode,
    schemaVersion: "fortune_v2",
    birthDate: input.birthDate,
    birthTime: input.birthTime,
    calendar: input.calendar,
    isLeapMonth: input.isLeapMonth,
    timezone: input.timezone,
    providerSex: input.providerSex,
    calculationOptions: {
      dayBoundary: input.calculationOptions.dayBoundary,
      timeCorrection: input.calculationOptions.timeCorrection,
    },
    consent: input.consent,
    externalProviderConsent: input.externalProviderConsent ?? null,
  });
  return createHmac("sha256", options.fingerprintSecret).update(canonical).digest("hex");
}

const safeErrorMessages = {
  PROVIDER_UNAVAILABLE: "사주 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  PROVIDER_TIMEOUT: "사주 서비스 응답이 지연되었습니다. 다시 시도해 주세요.",
  PROVIDER_RATE_LIMITED: "사주 서비스 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
  INVALID_PROVIDER_RESPONSE: "사주 결과의 형식이나 계산 기준을 확인하지 못했습니다.",
  PROVIDER_AUTH_FAILED: '사주 공급자 인증 설정을 확인해야 합니다.',
  PROVIDER_QUOTA_EXCEEDED: '사주 공급자의 이용 한도 또는 잔액을 확인해야 합니다.',
  PROVIDER_INPUT_REJECTED: '사주 공급자가 입력을 처리하지 못했습니다. 날짜와 계산 옵션을 확인해 주세요.',
  DAILY_LIMIT_REACHED: '오늘 사용할 수 있는 사주 계산 횟수를 모두 사용했어요. 내일 다시 시도해 주세요.',
  SERVICE_DAILY_LIMIT_REACHED: '오늘 사주 계산 이용량이 많아 잠시 멈췄어요. 내일 다시 시도해 주세요.',
} as const;
const notReadyMessages = {
  PROVIDER_NOT_CONFIGURED: '실제 사주 공급자의 연결 설정을 준비하고 있습니다.',
  PROVIDER_INPUT_UNSUPPORTED: '이 공급자는 계산용 성별 선택과 지원되는 날짜 경계 옵션이 필요합니다.',
  EXTERNAL_CONSENT_REQUIRED: 'HRUM에 출생정보를 전송하는 별도 동의가 필요합니다.',
} as const;
const pendingByProvider = new WeakMap<FortuneProvider, Map<string, Promise<FortuneResult>>>();
/** Process-wide cap on distinct in-flight calculations, shared by every user. */
export const MAX_PENDING_CALCULATIONS = 128;
/** Per-user cap so one account cannot exhaust the shared slots or start many billed calls at once. */
export const MAX_PENDING_CALCULATIONS_PER_USER = 2;
const pendingCountByUser = new Map<string, number>();

export async function calculateFortune(request: unknown, options: CalculateFortuneOptions): Promise<FortuneResult> {
  const input = fortuneInputSchema.parse(request);
  if (options.provider.id === 'hrum' && input.externalProviderConsent !== 'hrum_birth_data_v1') {
    return {status:'not_ready',reasonCode:'EXTERNAL_CONSENT_REQUIRED',message:notReadyMessages.EXTERNAL_CONSENT_REQUIRED};
  }
  const fingerprint = createFortuneFingerprint(input, options);
  let pending = pendingByProvider.get(options.provider);
  if (!pending) { pending = new Map(); pendingByProvider.set(options.provider, pending); }
  const existing = pending.get(fingerprint);
  if (existing) return structuredClone(await existing);
  const userPending = pendingCountByUser.get(options.userId) ?? 0;
  if (pending.size >= MAX_PENDING_CALCULATIONS || userPending >= MAX_PENDING_CALCULATIONS_PER_USER) {
    return {status:'error',code:'PROVIDER_RATE_LIMITED',retryable:true,message:safeErrorMessages.PROVIDER_RATE_LIMITED};
  }
  pendingCountByUser.set(options.userId, userPending + 1);
  // Include asynchronous cache lookup in the shared work so a delayed miss cannot
  // arrive after another identical computation and start a second billed call.
  const work = (async (): Promise<FortuneResult> => {
    const cached = await options.cache?.get(fingerprint);
    return cached ? { ...cached, cached: true } : computeFortune(input, fingerprint, options);
  })();
  pending.set(fingerprint, work);
  try { return await work; } finally {
    pending.delete(fingerprint);
    const remaining = (pendingCountByUser.get(options.userId) ?? 1) - 1;
    if (remaining > 0) pendingCountByUser.set(options.userId, remaining);
    else pendingCountByUser.delete(options.userId);
  }
}

/** Maps the DB claim to provider error codes. Any quota failure fails closed (no billed call). */
function claimFor(options: CalculateFortuneOptions): (() => Promise<FortuneErrorCode | null>) | undefined {
  const claim = options.claimProviderCall;
  if (!claim) return undefined;
  return async () => {
    try {
      const decision = await claim(options.userId);
      return decision === "ok" ? null : decision === "user_limit" ? "DAILY_LIMIT_REACHED" : "SERVICE_DAILY_LIMIT_REACHED";
    } catch {
      return "PROVIDER_UNAVAILABLE";
    }
  };
}

async function computeFortune(input: FortuneInput, fingerprint: string, options: CalculateFortuneOptions): Promise<FortuneResult> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<ProviderResult>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ status: "error", code: "PROVIDER_TIMEOUT", retryable: true, message: safeErrorMessages.PROVIDER_TIMEOUT });
    }, options.timeoutMs ?? 8000);
  });

  let response: ProviderResult;
  try {
    response = await Promise.race([
      options.provider.calculate(input, { signal: controller.signal, claimCall: claimFor(options) }),
      timeoutResult,
    ]);
  } catch {
    // Never return an upstream message, raw body, URL, key, or birth input.
    return { status: "error", code: "PROVIDER_UNAVAILABLE", retryable: true, message: safeErrorMessages.PROVIDER_UNAVAILABLE };
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === "not_ready") {
    return { status: "not_ready", reasonCode: response.reasonCode, message: notReadyMessages[response.reasonCode] };
  }
  if (response.status === "error") {
    return { status: "error", code: response.code, retryable: response.retryable, message: safeErrorMessages[response.code] };
  }

  const normalized = normalizedChartSchema.safeParse(response.data);
  const expectedBasis = input.birthTime === null ? "three_pillars" : "four_pillars";
  if (!normalized.success || normalized.data.chartBasis !== expectedBasis) {
    return { status: "error", code: "INVALID_PROVIDER_RESPONSE", retryable: false, message: safeErrorMessages.INVALID_PROVIDER_RESPONSE };
  }
  const result: Extract<FortuneResult, { status: "ready" }> = {
    status: "ready",
    source: options.provider.mode,
    provider: options.provider.id,
    providerVersion: options.provider.version,
    schemaVersion: "fortune_v2",
    providerEngineVersion: null,
    inputFingerprint: fingerprint,
    calculatedAt: (options.now?.() ?? new Date()).toISOString(),
    data: normalized.data,
    cached: false,
    persistence: "not_persisted",
  };
  await options.cache?.set(fingerprint, result);
  return result;
}
