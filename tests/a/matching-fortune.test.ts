import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MemoryFortuneCache } from "../../src/features/fortune/cache";
import { calculateFortuneForMatching, toMatchingFortuneInput } from "../../src/features/fortune/matching-input";
import { normalizeHrumResponse } from "../../src/features/fortune/providers/hrum-normalize";
import { createMockFortuneProvider } from "../../src/features/fortune/providers/mock";
import { fortuneInputSchema, type FortuneInput } from "../../src/features/fortune/schema";
import { calculateFortune } from "../../src/features/fortune/service";
import type { FortuneProvider, ReadyFortuneResult } from "../../src/features/fortune/types";

// Recorded guest calculations of invented test inputs. All calls below are local fixtures, never live API calls.
const threePillars = JSON.parse(readFileSync(new URL("../fixtures/hrum/three-pillars.json", import.meta.url), "utf8"));
const fourPillars = JSON.parse(readFileSync(new URL("../fixtures/hrum/four-pillars.json", import.meta.url), "utf8"));
const input = fortuneInputSchema.parse({
  birthDate: "2000-01-15", birthTime: "14:30", calendar: "solar", isLeapMonth: false,
  timezone: "Asia/Seoul", providerSex: "male", consent: true, externalProviderConsent: "hrum_birth_data_v1",
});
const userId = "aeb013eb-7816-424f-9a60-f60bb104ec33";
const anotherUserId = "50b93260-60ed-49cd-a184-c3c639c39a68";

function fixtureProvider() {
  const calls: FortuneInput[] = [];
  const provider: FortuneProvider = {
    id: "hrum", version: "hrum_adapter_2026_11_16_v1", mode: "provider",
    async calculate(request) {
      calls.push(structuredClone(request));
      return { status: "ready", data: normalizeHrumResponse(request.birthTime === null ? threePillars : fourPillars, request) };
    },
  };
  return { provider, calls };
}

function options(provider: FortuneProvider) {
  return {
    userId, provider, fingerprintSecret: "test-only-fingerprint-secret-never-for-production",
    now: () => new Date("2026-11-16T00:00:00.000Z"),
  };
}

async function readyResult(): Promise<ReadyFortuneResult> {
  const result = await calculateFortune({ ...input, birthTime: null }, options(fixtureProvider().provider));
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected local recorded fixture");
  return result;
}

test("matching explicitly recalculates known-hour input as three pillars once, without mutating input", async () => {
  const { provider, calls } = fixtureProvider();
  const original = structuredClone(input);
  const result = await calculateFortuneForMatching(input, options(provider));
  assert.equal(result.status, "ready");
  assert.equal(calls.length, 1);
  const firstCall = calls[0];
  assert.ok(firstCall);
  assert.equal(firstCall.birthTime, null);
  assert.deepEqual(input, original);
  if (result.status !== "ready") return;
  assert.equal(result.schemaVersion, "matching_fortune_v1");
  assert.equal(result.purpose, "matching_input_not_score");
  assert.equal(result.source, "provider");
  assert.equal(result.userId, userId);
  assert.equal(result.engineVersion, null);
  assert.equal(result.fortuneSchemaVersion, "fortune_v2");
  assert.deepEqual(Object.keys(result.chart), ["year", "month", "day"]);
  assert.equal(result.analysis.yongshin.selectionMethod, "balancing");
  assert.equal(result.analysis.yongshin.primary, "water");
  assert.equal(result.analysis.strength.result, "weak");
  assert.equal(Object.values(result.analysis.elementBalance.values).reduce((a, b) => a + b, 0), 6);
  for (const metric of Object.values(result.analysis)) assert.equal(metric.basis, "three_pillars");
  for (const absent of ["score", "birthDate", "birthTime", "raw", "interpretation"]) assert.equal(absent in result, false);
});

test("four-pillar detail and recomputed matching have separate cache keys", async () => {
  const { provider, calls } = fixtureProvider();
  const settings = { ...options(provider), cache: new MemoryFortuneCache() };
  const detail = await calculateFortune(input, settings);
  const matching = await calculateFortuneForMatching(input, settings);
  const repeat = await calculateFortuneForMatching(input, settings);
  assert.equal(detail.status, "ready");
  assert.equal(matching.status, "ready");
  assert.equal(repeat.status, "ready");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.birthTime), ["14:30", null]);
  if (detail.status !== "ready" || matching.status !== "ready" || repeat.status !== "ready") return;
  assert.notEqual(detail.inputFingerprint, matching.inputFingerprint);
  assert.equal(repeat.inputFingerprint, matching.inputFingerprint);
  assert.equal(repeat.cached, true);
});

test("unknown-time detail reuses its complete three-pillar calculation for matching", async () => {
  const { provider, calls } = fixtureProvider();
  const settings = { ...options(provider), cache: new MemoryFortuneCache() };
  const detail = await calculateFortune({ ...input, birthTime: null }, settings);
  const matching = await calculateFortuneForMatching({ ...input, birthTime: null }, settings);
  assert.equal(calls.length, 1);
  assert.equal(detail.status, "ready");
  assert.equal(matching.status, "ready");
  if (detail.status !== "ready" || matching.status !== "ready") return;
  assert.equal(matching.cached, true);
  assert.equal(matching.inputFingerprint, detail.inputFingerprint);
});

test("matching cache and fingerprints remain scoped to the verified owner", async () => {
  const { provider, calls } = fixtureProvider();
  const settings = { ...options(provider), cache: new MemoryFortuneCache() };
  const first = await calculateFortuneForMatching(input, settings);
  const second = await calculateFortuneForMatching(input, { ...settings, userId: anotherUserId });
  assert.equal(calls.length, 2);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  if (first.status !== "ready" || second.status !== "ready") return;
  assert.notEqual(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.comparisonKey, second.comparisonKey);
  assert.equal(second.userId, anotherUserId);
});

test("body owner injection and invalid original birth time are rejected before overriding the hour", async () => {
  const { provider, calls } = fixtureProvider();
  await assert.rejects(calculateFortuneForMatching({ ...input, userId: anotherUserId }, options(provider)));
  await assert.rejects(calculateFortuneForMatching({ ...input, birthTime: "99:00" }, options(provider)));
  assert.equal(calls.length, 0);
});

test("a valid UUID is required before any provider call", async () => {
  const { provider, calls } = fixtureProvider();
  for (const invalidId of ["", " ", "body-user-id"]) {
    const result = await calculateFortuneForMatching(input, { ...options(provider), userId: invalidId });
    assert.equal(result.status, "not_ready");
    if (result.status === "not_ready") assert.equal(result.reasonCode, "INVALID_USER_ID");
  }
  assert.equal(calls.length, 0);
});

test("mock and four-pillar results never become ready matching inputs", async () => {
  const mock = await calculateFortune({ ...input, birthTime: null }, options(createMockFortuneProvider()));
  const detail = await calculateFortune(input, options(fixtureProvider().provider));
  for (const [result, reasonCode] of [[mock, "MOCK_RESULT"], [detail, "THREE_PILLAR_BASIS_REQUIRED"]] as const) {
    const matching = toMatchingFortuneInput(result, userId);
    assert.equal(matching.status, "not_ready");
    if (matching.status === "not_ready") assert.equal(matching.reasonCode, reasonCode);
  }
});

test("all three derived metrics are required without inventing missing values", async () => {
  const original = await readyResult();
  for (const [field, reasonCode] of [
    ["elementBalance", "MISSING_ELEMENT_BALANCE"], ["yongshin", "MISSING_YONGSHIN"], ["strength", "MISSING_STRENGTH"],
  ] as const) {
    const changed = structuredClone(original); // Explicit synthetic omissions test failure behavior only.
    changed.data.analysis[field] = null;
    const result = toMatchingFortuneInput(changed, userId);
    assert.equal(result.status, "not_ready");
    if (result.status === "not_ready") assert.equal(result.reasonCode, reasonCode);
    assert.equal("analysis" in result, false);
  }
});

test("unmapped classifications and unknown analysis methods are not treated as approved inputs", async () => {
  const original = await readyResult();
  const unmappedYongshin = structuredClone(original);
  const unmappedStrength = structuredClone(original);
  const unsupportedMethod = structuredClone(original);
  assert.ok(unmappedYongshin.data.analysis.yongshin);
  assert.ok(unmappedStrength.data.analysis.strength);
  assert.ok(unsupportedMethod.data.analysis.yongshin);
  unmappedYongshin.data.analysis.yongshin.selectionMethod = "unmapped";
  unmappedStrength.data.analysis.strength.result = "unmapped";
  unsupportedMethod.data.analysis.yongshin.method = "unreviewed_synthetic_method";
  for (const [variant, reasonCode] of [
    [unmappedYongshin, "UNMAPPED_YONGSHIN_METHOD"],
    [unmappedStrength, "UNMAPPED_STRENGTH_RESULT"],
    [unsupportedMethod, "UNSUPPORTED_ANALYSIS_METHOD"],
  ] as const) {
    const result = toMatchingFortuneInput(variant, userId);
    assert.equal(result.status, "not_ready");
    if (result.status === "not_ready") assert.equal(result.reasonCode, reasonCode);
  }
});

test("mixed-basis analysis is revalidated at the DTO boundary", async () => {
  const changed = await readyResult();
  assert.ok(changed.data.analysis.strength);
  changed.data.analysis.strength.basis = "four_pillars"; // Explicit synthetic corruption.
  const result = toMatchingFortuneInput(changed, userId);
  assert.equal(result.status, "not_ready");
  if (result.status === "not_ready") assert.equal(result.reasonCode, "INVALID_RESULT");
});

test("comparison key separates adapter, calculation profile and timezone", async () => {
  const original = await readyResult();
  const first = toMatchingFortuneInput(original, userId);
  assert.equal(first.status, "ready");
  if (first.status !== "ready") return;
  const versions = [structuredClone(original), structuredClone(original), structuredClone(original)] as const;
  versions[0].providerVersion = "synthetic_next_adapter";
  versions[1].data.calculation.profileId = "synthetic_different_calculation_profile";
  versions[2].data.calculation.timezone = "Asia/Tokyo";
  for (const changed of versions) {
    const next = toMatchingFortuneInput(changed, userId);
    assert.equal(next.status, "ready");
    if (next.status === "ready") assert.notEqual(next.comparisonKey, first.comparisonKey);
  }
});

test("DTO owns copied analysis values and does not expose provider interpretation", async () => {
  const original = await readyResult();
  const result = toMatchingFortuneInput(original, userId);
  assert.equal(result.status, "ready");
  if (result.status !== "ready" || !original.data.analysis.yongshin) return;
  original.data.analysis.yongshin.secondary.push("earth");
  assert.deepEqual(result.analysis.yongshin.secondary, ["metal"]);
  assert.equal("interpretation" in result, false);
  assert.equal("data" in result, false);
});

test("upstream failures stay not_ready, retaining safe codes without upstream messages", () => {
  const unconfigured = toMatchingFortuneInput({ status: "not_ready", reasonCode: "PROVIDER_NOT_CONFIGURED", message: "private upstream detail" }, userId);
  assert.deepEqual(unconfigured, { schemaVersion: "matching_fortune_v1", purpose: "matching_input_not_score", status: "not_ready", reasonCode: "PROVIDER_NOT_CONFIGURED", retryable: false });
  const failed = toMatchingFortuneInput({ status: "error", code: "PROVIDER_TIMEOUT", retryable: true, message: "private upstream detail" }, userId);
  assert.equal(failed.status, "not_ready");
  if (failed.status === "not_ready") {
    assert.equal(failed.reasonCode, "PROVIDER_TIMEOUT");
    assert.equal(failed.retryable, true);
  }
  assert.equal("message" in failed, false);
});

test("external provider consent remains required for matching calls", async () => {
  const { provider, calls } = fixtureProvider();
  const request = { ...input, externalProviderConsent: undefined };
  const result = await calculateFortuneForMatching(request, options(provider));
  assert.equal(result.status, "not_ready");
  if (result.status === "not_ready") assert.equal(result.reasonCode, "EXTERNAL_CONSENT_REQUIRED");
  assert.equal(calls.length, 0);
});
