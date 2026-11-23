import type { FortuneInput } from "./schema";
import type { NormalizedChart } from "./normalization";

export type FortuneErrorCode = "PROVIDER_UNAVAILABLE" | "PROVIDER_TIMEOUT" | "PROVIDER_RATE_LIMITED" | "INVALID_PROVIDER_RESPONSE"
  | "PROVIDER_AUTH_FAILED" | "PROVIDER_QUOTA_EXCEEDED" | "PROVIDER_INPUT_REJECTED";
export type FortuneNotReadyCode = 'PROVIDER_NOT_CONFIGURED' | 'PROVIDER_INPUT_UNSUPPORTED' | 'EXTERNAL_CONSENT_REQUIRED';

export type FortuneResult =
  | {
      status: "ready";
      source: "mock" | "provider";
      provider: string;
      providerVersion: string;
      schemaVersion: "fortune_v2";
      providerEngineVersion: null;
      inputFingerprint: string;
      calculatedAt: string;
      data: NormalizedChart;
      cached: boolean;
      persistence: "not_persisted";
    }
  | { status: "not_ready"; reasonCode: FortuneNotReadyCode; message: string }
  | { status: "error"; code: FortuneErrorCode; retryable: boolean; message: string };

export type ReadyFortuneResult = Extract<FortuneResult, { status: "ready" }>;
export type ProviderResult =
  | { status: "ready"; data: unknown }
  | Extract<FortuneResult, { status: "not_ready" | "error" }>;

export interface FortuneProvider {
  readonly id: string;
  readonly version: string;
  readonly mode: "mock" | "provider";
  calculate(input: FortuneInput, options: { signal: AbortSignal }): Promise<ProviderResult>;
}

// B can replace the ephemeral implementation with an owner-scoped repository.
// It stores validated results only, never raw provider payloads or birth inputs.
export interface FortuneCache {
  get(key: string): Promise<ReadyFortuneResult | null>;
  set(key: string, value: ReadyFortuneResult): Promise<void>;
}
