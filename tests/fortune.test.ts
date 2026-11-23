import assert from "node:assert/strict";
import test from "node:test";
import { fortuneInputSchema } from "../src/features/fortune/schema";
import { normalizedChartSchema } from "../src/features/fortune/normalization";
import { createMockFortuneProvider } from "../src/features/fortune/providers/mock";
import { createUnconfiguredFortuneProvider } from "../src/features/fortune/providers/unconfigured";
import { calculateFortune, createFortuneFingerprint } from "../src/features/fortune/service";
import { MemoryFortuneCache } from "../src/features/fortune/cache";
import type { FortuneCache, FortuneProvider, ProviderResult, ReadyFortuneResult } from "../src/features/fortune/types";

const input = fortuneInputSchema.parse({
  birthDate: "2002-03-15", birthTime: null, calendar: "solar", isLeapMonth: false,
  timezone: "Asia/Seoul", providerSex: "unspecified", consent: true,
});
const options = {
  userId: "aeb013eb-7816-424f-9a60-f60bb104ec33",
  provider: createMockFortuneProvider(),
  fingerprintSecret: "test-only-fingerprint-secret-never-for-production",
  now: () => new Date("2026-11-16T00:00:00.000Z"),
};

async function fixture() {
  const response = await options.provider.calculate(input, { signal: new AbortController().signal });
  assert.equal(response.status, "ready");
  if (response.status !== "ready") throw new Error("Fixture unavailable");
  return normalizedChartSchema.parse(response.data);
}

test("rejects impossible solar dates, future dates and solar leap-month flag", () => {
  for (const changes of [{ birthDate: "2002-02-30" }, { birthDate: "2099-01-01" }, { isLeapMonth: true }]) {
    assert.equal(fortuneInputSchema.safeParse({ ...input, ...changes }).success, false);
  }
  assert.equal(fortuneInputSchema.safeParse({ ...input, birthDate: "2000-02-29" }).success, true);
});

test("accepts possible lunar day 30 without pretending to convert it to Gregorian", () => {
  assert.equal(fortuneInputSchema.safeParse({ ...input, calendar: "lunar", birthDate: "2002-02-30", isLeapMonth: true }).success, true);
  assert.equal(fortuneInputSchema.safeParse({ ...input, calendar: "lunar", birthDate: "2002-02-31" }).success, false);
});

test("requires consent, a valid timezone and canonical time; rejects injected owner IDs", () => {
  for (const changes of [{ consent: false }, { timezone: "Unknown/Nowhere" }, { birthTime: "24:00" }, { birthTime: "" }, { userId: "other-user" }]) {
    assert.equal(fortuneInputSchema.safeParse({ ...input, ...changes }).success, false);
  }
});

test("unknown birth time retains three pillars and no synthetic hour", async () => {
  const result = await calculateFortune(input, options);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.data.chartBasis, "three_pillars");
  assert.equal(result.data.chart.hour, null);
  assert.equal(result.source, "mock");
  assert.match(result.data.interpretation.title, /개발용/);
  const firstParagraph = result.data.interpretation.paragraphs[0];
  assert.ok(firstParagraph);
  assert.match(firstParagraph, /실제 사주가 아닙니다/);
  assert.equal(result.persistence, "not_persisted");
});

test("known birth time has separate four-pillar detail and no invented derived scores", async () => {
  const result = await calculateFortune({ ...input, birthTime: "00:00" }, options);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.data.chartBasis, "four_pillars");
  assert.notEqual(result.data.chart.hour, null);
  assert.deepEqual(result.data.analysis, { elementBalance: null, yongshin: null, strength: null });
  assert.equal("score" in result, false);
});

test("real provider remains not_ready without an adapter; never falls back to a mock", async () => {
  const result = await calculateFortune(input, { ...options, provider: createUnconfiguredFortuneProvider() });
  assert.equal(result.status, "not_ready");
  assert.equal("data" in result, false);
});

test("rejects unknown stem codes and unexpected raw payload fields", async () => {
  const data = await fixture();
  assert.equal(normalizedChartSchema.safeParse({ ...data, chart: { ...data.chart, day: { stem: "invented", branch: "ja" } } }).success, false);
  assert.equal(normalizedChartSchema.safeParse({ ...data, raw: { birthDate: input.birthDate } }).success, false);
});

test("rejects four-pillar derived analysis mixed into three-pillar data", async () => {
  const data = await fixture();
  data.analysis.strength = { basis: "four_pillars", method: "synthetic-test", dayMaster: 'mu', score:0, result:'balanced', providerResult:'중화', level:'synthetic', breakdown:null, root:null };
  assert.equal(normalizedChartSchema.safeParse(data).success, false);
});

test("rejects a provider filling an unknown birth time with a made-up hour", async () => {
  const provider: FortuneProvider = {
    ...options.provider,
    async calculate() {
      const data = await fixture();
      return { status: "ready", data: { ...data, chartBasis: "four_pillars", chart: { ...data.chart, hour: { stem: "gap", branch: "ja" } } } };
    },
  };
  const result = await calculateFortune(input, { ...options, provider });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
});

test("fingerprint covers owner, provider version and every calculation option", () => {
  const original = createFortuneFingerprint(input, options);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.notEqual(original, createFortuneFingerprint(input, { ...options, userId: "other-verified-user" }));
  assert.notEqual(original, createFortuneFingerprint(input, { ...options, provider: { ...options.provider, version: "v2" } }));
  for (const changes of [
    { birthDate: "2002-03-16" }, { birthTime: "12:00" }, { calendar: "lunar" as const }, { isLeapMonth: true },
    { timezone: "UTC" }, { providerSex: "female" as const },
    { calculationOptions: { ...input.calculationOptions, dayBoundary: "civil_midnight" as const } },
    { calculationOptions: { ...input.calculationOptions, timeCorrection: "none" as const } },
  ]) {
    assert.notEqual(original, createFortuneFingerprint({ ...input, ...changes }, options));
  }
  assert.equal(original.includes(input.birthDate), false);
});

test("fingerprint is stable across input property order and requires a private secret", () => {
  assert.equal(createFortuneFingerprint(input, options), createFortuneFingerprint({ ...input, calculationOptions: { timeCorrection: input.calculationOptions.timeCorrection, dayBoundary: input.calculationOptions.dayBoundary } }, options));
  assert.throws(() => createFortuneFingerprint(input, { ...options, fingerprintSecret: "short" }));
  assert.throws(() => createFortuneFingerprint(input, { ...options, userId: "" }));
});

test("identical request reuses owner-scoped result; another owner calls provider again", async () => {
  let calls = 0;
  const provider: FortuneProvider = { ...options.provider, async calculate(value, context) { calls++; return options.provider.calculate(value, context); } };
  const cache = new MemoryFortuneCache();
  const first = await calculateFortune(input, { ...options, provider, cache });
  const second = await calculateFortune(input, { ...options, provider, cache });
  await calculateFortune(input, { ...options, provider, cache, userId: "another-user" });
  assert.equal(calls, 2);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  if (first.status === "ready" && second.status === "ready") {
    assert.equal(second.cached, true);
    assert.equal(second.calculatedAt, first.calculatedAt);
    assert.deepEqual(second.data, first.data);
  }
});

test("upstream failures are sanitized and never cached as successful results", async () => {
  let calls = 0;
  const provider: FortuneProvider = { ...options.provider, async calculate() { calls++; throw new Error("secret-provider-key birthDate=2002-03-15"); } };
  const cache = new MemoryFortuneCache();
  const result = await calculateFortune(input, { ...options, provider, cache });
  await calculateFortune(input, { ...options, provider, cache });
  assert.equal(calls, 2);
  assert.equal(result.status, "error");
  assert.equal(JSON.stringify(result).includes("secret-provider-key"), false);
  assert.equal(JSON.stringify(result).includes(input.birthDate), false);
});

test("rate limit stays retryable and upstream error text is removed", async () => {
  const provider: FortuneProvider = { ...options.provider, async calculate() { return { status: "error", code: "PROVIDER_RATE_LIMITED", retryable: true, message: "raw secret response" }; } };
  const result = await calculateFortune(input, { ...options, provider });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "PROVIDER_RATE_LIMITED");
    assert.equal(result.retryable, true);
    assert.notEqual(result.message, "raw secret response");
  }
});

test("timeout aborts provider and returns a retryable failure without a sample fallback", async () => {
  let signal: AbortSignal | undefined;
  const provider: FortuneProvider = { ...options.provider, calculate(_input, context) { signal = context.signal; return new Promise(() => {}); } };
  const result = await calculateFortune(input, { ...options, provider, timeoutMs: 5 });
  assert.equal(signal?.aborted, true);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PROVIDER_TIMEOUT");
});

test("ephemeral cache expires, caps entries, and protects values from caller mutation", async () => {
  let now = 100;
  const cache = new MemoryFortuneCache(1, 50, () => now);
  const result = await calculateFortune(input, options) as ReadyFortuneResult;
  await cache.set("first", result);
  const retrieved = await cache.get("first");
  assert.ok(retrieved);
  retrieved.data.interpretation.title = "Mutated";
  assert.notEqual((await cache.get("first"))?.data.interpretation.title, "Mutated");
  await cache.set("second", result);
  assert.equal(await cache.get("first"), null);
  now = 151;
  assert.equal(await cache.get("second"), null);
});

test("simultaneous identical calculations share one provider call and return independent results", async () => {
  const gate = Promise.withResolvers<ProviderResult>();
  const entered = Promise.withResolvers<void>();
  const data = await fixture();
  let calls = 0;
  const provider: FortuneProvider = {
    ...options.provider,
    calculate() { calls++; entered.resolve(); return gate.promise; },
  };
  const cache = new MemoryFortuneCache();
  const requests = Array.from({ length: 12 }, () => calculateFortune(input, { ...options, provider, cache }));
  await entered.promise;
  gate.resolve({ status: "ready", data });
  const results = await Promise.all(requests);
  assert.equal(calls, 1);
  for (const result of results) assert.equal(result.status, "ready");
  const first = results[0] as ReadyFortuneResult;
  const second = results[1] as ReadyFortuneResult;
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.data, second.data);
  first.data.interpretation.title = "caller mutation";
  assert.notEqual(second.data.interpretation.title, "caller mutation");
  const cached = await calculateFortune(input, { ...options, provider, cache });
  assert.equal(cached.status, "ready");
  if (cached.status === "ready") {
    assert.equal(cached.cached, true);
    assert.notEqual(cached.data.interpretation.title, "caller mutation");
  }
  assert.equal(calls, 1);
});

test("simultaneous calls for different owners never share calculation or cache identity", async () => {
  const gate = Promise.withResolvers<ProviderResult>();
  const bothEntered = Promise.withResolvers<void>();
  const data = await fixture();
  let calls = 0;
  const provider: FortuneProvider = {
    ...options.provider,
    calculate() { calls++; if (calls === 2) bothEntered.resolve(); return gate.promise; },
  };
  const cache = new MemoryFortuneCache();
  const first = calculateFortune(input, { ...options, provider, cache });
  const second = calculateFortune(input, { ...options, provider, cache, userId: "b5077bd7-c240-4fd7-af91-7dccba02989f" });
  await bothEntered.promise;
  gate.resolve({ status: "ready", data });
  const [ownerA, ownerB] = await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(ownerA.status, "ready");
  assert.equal(ownerB.status, "ready");
  if (ownerA.status === "ready" && ownerB.status === "ready") assert.notEqual(ownerA.inputFingerprint, ownerB.inputFingerprint);
});

test("a failed shared calculation is released so a later explicit request can try again", async () => {
  const gate = Promise.withResolvers<ProviderResult>();
  const entered = Promise.withResolvers<void>();
  const data = await fixture();
  let calls = 0;
  const provider: FortuneProvider = {
    ...options.provider,
    async calculate() {
      calls++;
      entered.resolve();
      return calls === 1 ? gate.promise : { status: "ready", data };
    },
  };
  const cache = new MemoryFortuneCache();
  const requests = [calculateFortune(input, { ...options, provider, cache }), calculateFortune(input, { ...options, provider, cache })];
  await entered.promise;
  gate.resolve({ status: "error", code: "PROVIDER_UNAVAILABLE", retryable: true, message: "private provider error" });
  const failures = await Promise.all(requests);
  assert.equal(calls, 1);
  for (const result of failures) {
    assert.equal(result.status, "error");
    assert.equal(JSON.stringify(result).includes("private provider error"), false);
  }
  const next = await calculateFortune(input, { ...options, provider, cache });
  assert.equal(next.status, "ready");
  assert.equal(calls, 2);
});

test("an expired calculation releases its in-flight entry after abort for a subsequent request", async () => {
  const data = await fixture();
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const provider: FortuneProvider = {
    ...options.provider,
    async calculate(_value, context) {
      calls++;
      if (calls === 1) { firstSignal = context.signal; return new Promise(() => {}); }
      return { status: "ready", data };
    },
  };
  const expired = await calculateFortune(input, { ...options, provider, timeoutMs: 5 });
  assert.equal(expired.status, "error");
  if (expired.status === "error") assert.equal(expired.code, "PROVIDER_TIMEOUT");
  assert.equal(firstSignal?.aborted, true);
  assert.equal((await calculateFortune(input, { ...options, provider })).status, "ready");
  assert.equal(calls, 2);
});

test("HRUM external consent is checked before any cache read, including an available cached result", async () => {
  const ready = await calculateFortune(input, options) as ReadyFortuneResult;
  let reads = 0;
  let calls = 0;
  const provider: FortuneProvider = {
    ...options.provider, id: "hrum", mode: "provider",
    async calculate(value, context) { calls++; return options.provider.calculate(value, context); },
  };
  const cache: FortuneCache = { async get() { reads++; return ready; }, async set() {} };
  const result = await calculateFortune(input, { ...options, provider, cache });
  assert.equal(result.status, "not_ready");
  if (result.status === "not_ready") assert.equal(result.reasonCode, "EXTERNAL_CONSENT_REQUIRED");
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  const consented = { ...input, externalProviderConsent: "hrum_birth_data_v1" as const };
  assert.notEqual(createFortuneFingerprint(input, { ...options, provider }), createFortuneFingerprint(consented, { ...options, provider }));
});

test("in-flight deduplication includes asynchronous cache lookup so stale misses cannot duplicate paid work", async () => {
  const cacheReadGate = Promise.withResolvers<ReadyFortuneResult | null>();
  const staleSecondReadGate = Promise.withResolvers<ReadyFortuneResult | null>();
  const cacheEntered = Promise.withResolvers<void>();
  const data = await fixture();
  let reads = 0;
  let calls = 0;
  const cache: FortuneCache = {
    async get() { reads++; cacheEntered.resolve(); return reads === 1 ? cacheReadGate.promise : staleSecondReadGate.promise; },
    async set() {},
  };
  const provider: FortuneProvider = { ...options.provider, async calculate() { calls++; return { status: "ready", data }; } };
  const first = calculateFortune(input, { ...options, provider, cache });
  const second = calculateFortune(input, { ...options, provider, cache });
  await cacheEntered.promise;
  cacheReadGate.resolve(null);
  const firstResult = await first;
  // A competing database cache read may still return the miss it observed before the first write.
  staleSecondReadGate.resolve(null);
  const secondResult = await second;
  assert.equal(calls, 1);
  assert.equal(firstResult.status, "ready");
  assert.equal(secondResult.status, "ready");
});

test("one user cannot hold more than the per-user in-flight limit while other users still proceed", async () => {
  const { MAX_PENDING_CALCULATIONS_PER_USER } = await import("../src/features/fortune/service");
  const releases: Array<() => void> = [];
  const base = createMockFortuneProvider();
  const provider: FortuneProvider = {
    ...base,
    async calculate(value, context) {
      await new Promise<void>((resolve) => releases.push(resolve));
      return base.calculate(value, context);
    },
  };
  const heavyUser = { ...options, provider, userId: "11111111-1111-4111-8111-111111111111" };
  const otherUser = { ...options, provider, userId: "22222222-2222-4222-8222-222222222222" };
  const dates = ["2001-01-01", "2001-01-02", "2001-01-03"];
  const held = dates.slice(0, MAX_PENDING_CALCULATIONS_PER_USER).map((birthDate) => calculateFortune({ ...input, birthDate }, heavyUser));
  const rejected = await calculateFortune({ ...input, birthDate: dates[MAX_PENDING_CALCULATIONS_PER_USER] }, heavyUser);
  assert.equal(rejected.status, "error");
  if (rejected.status === "error") assert.equal(rejected.code, "PROVIDER_RATE_LIMITED");
  const other = calculateFortune(input, otherUser);
  while (releases.length < MAX_PENDING_CALCULATIONS_PER_USER + 1) await new Promise((resolve) => setImmediate(resolve));
  releases.forEach((release) => release());
  assert.equal((await other).status, "ready");
  for (const result of await Promise.all(held)) assert.equal(result.status, "ready");
  // Slots are released after completion.
  const again = calculateFortune({ ...input, birthDate: "2001-01-04" }, heavyUser);
  while (releases.length < MAX_PENDING_CALCULATIONS_PER_USER + 2) await new Promise((resolve) => setImmediate(resolve));
  releases.at(-1)?.();
  assert.equal((await again).status, "ready");
});
