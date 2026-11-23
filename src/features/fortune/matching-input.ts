import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizedChartSchema, type NormalizedChart } from "./normalization";
import { fortuneInputSchema } from "./schema";
import { calculateFortune, type CalculateFortuneOptions } from "./service";
import type { FortuneErrorCode, FortuneNotReadyCode, FortuneResult } from "./types";

type DeepReadonly<T> = { readonly [Key in keyof T]: DeepReadonly<T[Key]> };
type ElementBalance = NonNullable<NormalizedChart["analysis"]["elementBalance"]>;
type Yongshin = NonNullable<NormalizedChart["analysis"]["yongshin"]>;
type Strength = NonNullable<NormalizedChart["analysis"]["strength"]>;

export type MatchingFortuneNotReadyCode = FortuneErrorCode | FortuneNotReadyCode
  | "INVALID_USER_ID" | "MOCK_RESULT" | "THREE_PILLAR_BASIS_REQUIRED" | "INVALID_RESULT"
  | "MISSING_ELEMENT_BALANCE" | "MISSING_YONGSHIN" | "MISSING_STRENGTH"
  | "UNMAPPED_YONGSHIN_METHOD" | "UNMAPPED_STRENGTH_RESULT" | "UNSUPPORTED_ANALYSIS_METHOD";

type MatchingMetadata = {
  schemaVersion: "matching_fortune_v1";
  purpose: "matching_input_not_score";
};

export type ReadyMatchingFortuneInput = DeepReadonly<MatchingMetadata & {
  status: "ready";
  source: "provider";
  /** Must come from getCurrentUserId(), never the request body. UUID validation is not authentication. */
  userId: string;
  provider: string;
  adapterVersion: string;
  engineVersion: null;
  fortuneSchemaVersion: "fortune_v2";
  inputFingerprint: string;
  calculatedAt: string;
  comparisonKey: string;
  chartBasis: "three_pillars";
  chart: Pick<NormalizedChart["chart"], "year" | "month" | "day">;
  calculation: NormalizedChart["calculation"];
  analysis: {
    elementBalance: ElementBalance & { basis: "three_pillars" };
    yongshin: Omit<Yongshin, "basis" | "selectionMethod"> & { basis: "three_pillars"; selectionMethod: Exclude<Yongshin["selectionMethod"], "unmapped"> };
    strength: Omit<Strength, "basis" | "result"> & { basis: "three_pillars"; result: Exclude<Strength["result"], "unmapped"> };
  };
  cached: boolean;
  persistence: "not_persisted";
}>;

export type MatchingFortuneInput = ReadyMatchingFortuneInput | DeepReadonly<MatchingMetadata & {
  status: "not_ready";
  reasonCode: MatchingFortuneNotReadyCode;
  retryable: boolean;
}>;

const userIdSchema = z.uuid();
const metadata = { schemaVersion: "matching_fortune_v1", purpose: "matching_input_not_score" } as const;

function notReady(reasonCode: MatchingFortuneNotReadyCode, retryable = false): MatchingFortuneInput {
  return { ...metadata, status: "not_ready", reasonCode, retryable };
}

/** An explicit allowlist, not an inference from a provider's free-form method label. */
function hasSupportedMethods(provider: string, analysis: { elementBalance: ElementBalance; yongshin: Yongshin; strength: Strength }) {
  return provider === "hrum"
    && analysis.elementBalance.method === "hrum_surface_counts_v1"
    && analysis.yongshin.method === "hrum_five_methods_v1"
    && analysis.strength.method === "hrum_strength_v1";
}

/** Converts one validated three-pillar calculation into B's input. It never scores two people. */
export function toMatchingFortuneInput(result: FortuneResult, userId: string): MatchingFortuneInput {
  if (!userIdSchema.safeParse(userId).success) return notReady("INVALID_USER_ID");
  if (result.status === "not_ready") return notReady(result.reasonCode);
  if (result.status === "error") return notReady(result.code, result.retryable);
  if (result.source !== "provider") return notReady("MOCK_RESULT");
  if (result.data.chartBasis !== "three_pillars") return notReady("THREE_PILLAR_BASIS_REQUIRED");

  // Revalidate at the handoff boundary and clone selected fields; do not trust a caller's type assertion.
  const parsed = normalizedChartSchema.safeParse(result.data);
  if (!parsed.success) return notReady("INVALID_RESULT");
  const data = parsed.data;
  const { elementBalance, yongshin, strength } = data.analysis;
  if (!elementBalance) return notReady("MISSING_ELEMENT_BALANCE");
  if (!yongshin) return notReady("MISSING_YONGSHIN");
  if (!strength) return notReady("MISSING_STRENGTH");
  if (yongshin.selectionMethod === "unmapped") return notReady("UNMAPPED_YONGSHIN_METHOD");
  if (strength.result === "unmapped") return notReady("UNMAPPED_STRENGTH_RESULT");
  if (!hasSupportedMethods(result.provider, { elementBalance, yongshin, strength })) return notReady("UNSUPPORTED_ANALYSIS_METHOD");
  if (data.calculation.dayBoundary === "mock" || data.calculation.timeCorrection === "mock") return notReady("INVALID_RESULT");

  // Metadata only: no birth input, user ID or secret is used in this grouping key.
  // Equal keys are necessary, not sufficient: HRUM exposes no upstream engine version.
  const comparisonKey = createHash("sha256").update(JSON.stringify({
    schemaVersion: metadata.schemaVersion,
    fortuneSchemaVersion: result.schemaVersion,
    provider: result.provider,
    adapterVersion: result.providerVersion,
    engineVersion: result.providerEngineVersion,
    chartBasis: "three_pillars",
    calculation: {
      profileId: data.calculation.profileId, timezone: data.calculation.timezone,
      dayBoundary: data.calculation.dayBoundary, timeCorrection: data.calculation.timeCorrection,
    },
    methods: { elementBalance: elementBalance.method, yongshin: yongshin.method, strength: strength.method },
  })).digest("hex");

  return {
    ...metadata, status: "ready", source: result.source, userId,
    provider: result.provider, adapterVersion: result.providerVersion, engineVersion: result.providerEngineVersion,
    fortuneSchemaVersion: result.schemaVersion, inputFingerprint: result.inputFingerprint,
    calculatedAt: result.calculatedAt, comparisonKey, chartBasis: "three_pillars",
    chart: { year: data.chart.year, month: data.chart.month, day: data.chart.day },
    calculation: data.calculation,
    analysis: {
      elementBalance: { ...elementBalance, basis: "three_pillars" },
      yongshin: { ...yongshin, basis: "three_pillars", selectionMethod: yongshin.selectionMethod },
      strength: { ...strength, basis: "three_pillars", result: strength.result },
    },
    cached: result.cached, persistence: result.persistence,
  };
}

/** Recalculates all derived metrics without a birth hour; a four-pillar result is never sliced. */
export async function calculateFortuneForMatching(request: unknown, options: CalculateFortuneOptions): Promise<MatchingFortuneInput> {
  const input = fortuneInputSchema.parse(request);
  if (!userIdSchema.safeParse(options.userId).success) return notReady("INVALID_USER_ID");
  const result = await calculateFortune({ ...input, birthTime: null }, options);
  return toMatchingFortuneInput(result, options.userId);
}
