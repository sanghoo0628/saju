import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateFortuneForMatching } from "../../src/features/fortune/matching-input";
import { normalizeHrumResponse } from "../../src/features/fortune/providers/hrum-normalize";
import { createMockFortuneProvider } from "../../src/features/fortune/providers/mock";
import { fortuneInputSchema, MATCHING_STORAGE_CONSENT_VERSION } from "../../src/features/fortune/schema";
import { calculateFortune, createFortuneFingerprint } from "../../src/features/fortune/service";
import {
  storeBirthInputIfConsented, storeMatchingAnalysisIfConsented,
  type BirthInputForStorage, type FortuneStorageRecorder,
} from "../../src/features/fortune/storage";
import type { FortuneProvider } from "../../src/features/fortune/types";
import type { MatchingFortuneInput, ReadyMatchingFortuneInput } from "../../src/features/fortune/matching-input";
import {
  BIRTH_STORAGE_CONSENT_VERSION, createMatchingService,
  type BirthInputWrite, type FortuneAnalysisWrite, type MatchingStore,
} from "../../src/server/matching-service";

const userId = "aeb013eb-7816-424f-9a60-f60bb104ec33";
const base = {
  birthDate: "2002-03-15", birthTime: "09:10", calendar: "solar", isLeapMonth: false,
  timezone: "Asia/Seoul", providerSex: "unspecified", consent: true,
} as const;
const consented = fortuneInputSchema.parse({ ...base, matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION });
const notConsented = fortuneInputSchema.parse(base);

function recorder(overrides: Partial<FortuneStorageRecorder> = {}) {
  const births: Array<{ userId: string; input: BirthInputForStorage }> = [];
  const analyses: Array<{ userId: string; dto: ReadyMatchingFortuneInput }> = [];
  const value: FortuneStorageRecorder = {
    async recordBirthInput(id, input) { births.push({ userId: id, input }); },
    async recordMatchingAnalysis(id, dto) { analyses.push({ userId: id, dto }); },
    ...overrides,
  };
  return { value, births, analyses };
}

test("A consent version matches B's BIRTH_STORAGE_CONSENT_VERSION", () => {
  assert.equal(MATCHING_STORAGE_CONSENT_VERSION, BIRTH_STORAGE_CONSENT_VERSION);
});

test("schema accepts only the exact storage consent version and keeps the field optional", () => {
  assert.equal(notConsented.matchingStorageConsent, undefined);
  assert.equal(consented.matchingStorageConsent, "matching_birth_storage_v1");
  for (const value of [true, "on", "matching_birth_storage_v2", ""]) {
    assert.equal(fortuneInputSchema.safeParse({ ...base, matchingStorageConsent: value }).success, false);
  }
});

test("storage consent does not change the fortune fingerprint, so a retry reuses the cached calculation", () => {
  const options = { userId, provider: createMockFortuneProvider(), fingerprintSecret: "test-only-fingerprint-secret-never-for-production" };
  assert.equal(createFortuneFingerprint(consented, options), createFortuneFingerprint(notConsented, options));
});

test("consented solar input sends only birth date, calendar, leap month and timezone", async () => {
  const r = recorder();
  const outcome = await storeBirthInputIfConsented(userId, consented, () => r.value);
  assert.deepEqual(outcome, { status: "stored" });
  assert.deepEqual(r.births, [{ userId, input: { birthDate: "2002-03-15", calendar: "solar", isLeapMonth: false, timezone: "Asia/Seoul" } }]);
  const sent = r.births[0]?.input as unknown as Record<string, unknown>;
  for (const key of ["birthTime", "providerSex", "calculationOptions", "consent", "externalProviderConsent", "matchingStorageConsent"]) {
    assert.equal(key in sent, false, key);
  }
});

test("without consent nothing reaches B", async () => {
  let calls = 0;
  const getRecorder = () => { calls += 1; return recorder().value; };
  assert.deepEqual(await storeBirthInputIfConsented(userId, notConsented, getRecorder), { status: "not_consented" });
  assert.equal(calls, 0);
});

test("storage no longer depends on the fortune result (provider missing or failing)", async () => {
  // The route runs storage independently of calculateFortune; the storage step takes no result at all.
  assert.equal(storeBirthInputIfConsented.length, 3);
  const r = recorder();
  assert.deepEqual(await storeBirthInputIfConsented(userId, consented, () => r.value), { status: "stored" });
  assert.equal(r.births.length, 1);
});

test("invalid solar dates are rejected by the schema before storage can run", () => {
  for (const birthDate of ["2002-02-30", "2099-01-01", "2002-13-01"]) {
    assert.equal(fortuneInputSchema.safeParse({ ...base, birthDate, matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION }).success, false, birthDate);
  }
});

test("unconfigured matching and B failures are reported without throwing", async () => {
  const unavailable = await storeBirthInputIfConsented(userId, consented, () => { throw new Error("MATCHING_NOT_CONFIGURED"); });
  assert.deepEqual(unavailable, { status: "unavailable" });
  const r = recorder({ async recordBirthInput() { throw new Error("raw db error with 2002-03-15"); } });
  assert.deepEqual(await storeBirthInputIfConsented(userId, consented, () => r.value), { status: "failed" });
});

test("lunar and leap-month input is not stored for matching yet (solar-only MVP)", async () => {
  let calls = 0;
  const getRecorder = () => { calls += 1; return recorder().value; };
  for (const isLeapMonth of [false, true]) {
    const lunar = fortuneInputSchema.parse({ ...base, birthTime: null, calendar: "lunar", birthDate: "2001-04-30", isLeapMonth, matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION });
    assert.deepEqual(await storeBirthInputIfConsented(userId, lunar, getRecorder), { status: "calendar_unsupported" });
  }
  assert.equal(calls, 0);
});

// B's real service with a minimal in-memory store: proves the two contracts fit end to end.
function bService() {
  const births: BirthInputWrite[] = [];
  const analyses: FortuneAnalysisWrite[] = [];
  const store = {
    async saveBirthInput(row: BirthInputWrite) { births.push(row); },
    async saveFortuneAnalysis(row: FortuneAnalysisWrite) { analyses.push(row); },
  } as unknown as MatchingStore;
  const service = createMatchingService(store, { scoreSecret: "test-only-score-secret" });
  const value: FortuneStorageRecorder = {
    recordBirthInput: (id, input) => service.recordBirthInput(id, input),
    recordMatchingAnalysis: (id, dto) => service.recordMatchingAnalysis(id, dto),
  };
  return { value, births, analyses };
}

test("B MatchingService stores A's birth input with the consent version and no birth time", async () => {
  const b = bService();
  assert.deepEqual(await storeBirthInputIfConsented(userId, consented, () => b.value), { status: "stored" });
  assert.equal(b.births.length, 1);
  const row = b.births[0] as unknown as Record<string, unknown>;
  assert.equal(row.userId, userId);
  assert.equal(row.consentVersion, BIRTH_STORAGE_CONSENT_VERSION);
  assert.equal(row.calendar, "solar");
  assert.equal(row.date, "2002-03-15");
  assert.equal("birthTime" in row, false);
});

const threePillars = JSON.parse(readFileSync(new URL("../fixtures/hrum/three-pillars.json", import.meta.url), "utf8"));

test("a ready three-pillar analysis is stored through B only with consent", async () => {
  const provider: FortuneProvider = {
    id: "hrum", version: "hrum_adapter_2026_11_16_v1", mode: "provider",
    async calculate(request) { return { status: "ready", data: normalizeHrumResponse(threePillars, request) }; },
  };
  const hrumInput = { ...base, providerSex: "male", externalProviderConsent: "hrum_birth_data_v1", matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION } as const;
  const input = fortuneInputSchema.parse(hrumInput);
  const result: MatchingFortuneInput = await calculateFortuneForMatching(input, {
    userId, provider, fingerprintSecret: "test-only-fingerprint-secret-never-for-production",
  });
  assert.equal(result.status, "ready");
  const b = bService();
  assert.deepEqual(await storeMatchingAnalysisIfConsented(userId, input, result, () => b.value), { status: "stored" });
  assert.equal(b.analyses.length, 1);
  assert.equal(b.analyses[0]?.userId, userId);
  assert.equal(b.analyses[0]?.chartBasis, "three_pillars");

  const withoutConsent = fortuneInputSchema.parse({ ...hrumInput, matchingStorageConsent: undefined });
  const none = bService();
  assert.deepEqual(await storeMatchingAnalysisIfConsented(userId, withoutConsent, result, () => none.value), { status: "not_consented" });
  assert.equal(none.analyses.length, 0);
});

test("fortune calculation result is unchanged by the consent field", async () => {
  const options = { userId, provider: createMockFortuneProvider(), fingerprintSecret: "test-only-fingerprint-secret-never-for-production" };
  const a = await calculateFortune({ ...base, birthTime: null }, options);
  const b = await calculateFortune({ ...base, birthTime: null, matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION }, options);
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  if (a.status === "ready" && b.status === "ready") assert.deepEqual(a.data, b.data);
});

test("a different date after the score exists reports locked, not a generic failure", async () => {
  const { MatchingError } = await import("../../src/server/matching-service");
  const locked = recorder({ async recordBirthInput() { throw new MatchingError("BIRTH_INPUT_LOCKED", "locked"); } });
  assert.deepEqual(await storeBirthInputIfConsented(userId, consented, () => locked.value), { status: "locked" });
  const changed = recorder({ async recordBirthInput() { throw new MatchingError("BIRTH_INPUT_CHANGED", "changed"); } });
  assert.deepEqual(await storeBirthInputIfConsented(userId, consented, () => changed.value), { status: "failed" });
});
