import assert from "node:assert/strict";
import test from "node:test";
import threePillars from "../fixtures/hrum/three-pillars.json";
import fourPillars from "../fixtures/hrum/four-pillars.json";
import { fortuneInputSchema, type FortuneInput } from "../../src/features/fortune/schema";
import { normalizedChartSchema } from "../../src/features/fortune/normalization";
import { createHrumFortuneProvider } from "../../src/features/fortune/providers/hrum";
import { normalizeHrumResponse } from "../../src/features/fortune/providers/hrum-normalize";

const input = fortuneInputSchema.parse({
  birthDate: "2000-01-15", birthTime: null, timezone: "Asia/Seoul", calendar: "solar", isLeapMonth: false,
  providerSex: "male", consent: true, externalProviderConsent: "hrum_birth_data_v1",
});
const key = "test-only-key-never-a-live-credential";
const signal = () => new AbortController().signal;
const withData = (changes: Record<string, unknown>) => ({ ...threePillars, data: { ...threePillars.data, ...changes } });

async function calculate(payload: unknown = threePillars, value: FortuneInput = input) {
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async () => Response.json(payload) });
  return provider.calculate(value, { signal: signal() });
}

test("HRUM sends only documented birth fields to the fixed partner endpoint", async () => {
  let calls = 0;
  const requestSignal = signal();
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.hrum.ai/api/v1/partners/v1/manseryeok");
    assert.equal(init?.method, "POST");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.signal, requestSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Partner-Api-Key"), key);
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.equal(headers.get("User-Agent"), "sai-campus/0.1.0");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      year: 2000, month: 1, day: 15, timezone: "Asia/Seoul", gender: "male", calendar: "solar", isLeapMonth: false,
      lang: "ko", zaSiRule: "traditional", birthTimePrecision: "unknown",
    });
    return Response.json(threePillars);
  } });
  const result = await provider.calculate(input, { signal: requestSignal });
  assert.equal(result.status, "ready");
  assert.equal(calls, 1);
  assert.equal(provider.mode, "provider");
  assert.equal(provider.version, "hrum_adapter_2026_11_16_v1");
});

test("known time is transmitted exactly and civil-midnight explicitly selects yajaSi", async () => {
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.hour, 14);
    assert.equal(body.minute, 30);
    assert.equal(body.birthTimePrecision, "exact");
    assert.equal(body.zaSiRule, "yajaSi");
    for (const excluded of ["country", "birthLatitude", "birthLongitude", "name", "consent", "externalProviderConsent", "userId"]) {
      assert.equal(excluded in body, false);
    }
    return Response.json(fourPillars);
  } });
  const result = await provider.calculate({ ...input, birthTime: "14:30", calculationOptions: { dayBoundary: "civil_midnight", timeCorrection: "none" } }, { signal: signal() });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const data = normalizedChartSchema.parse(result.data);
  assert.equal(data.calculation.profileId, "hrum_no_location_yajasi_v1");
  assert.equal(data.calculation.dayBoundary, "civil_midnight");
  assert.equal(data.chart.hour?.branch, "mi");
  assert.equal(data.analysis.strength?.score, -66);
});

test("lunar and leap-month inputs pass through without a made-up solar conversion", async () => {
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.calendar, "lunar");
    assert.equal(body.isLeapMonth, true);
    assert.equal(body.day, 30);
    assert.equal(body.month, 2);
    return Response.json(threePillars);
  } });
  assert.equal((await provider.calculate({ ...input, birthDate: "2000-02-30", calendar: "lunar", isLeapMonth: true }, { signal: signal() })).status, "ready");
});

test("HRUM normalizes measured three-pillar yongshin and strength without inventing a score", () => {
  const result = normalizeHrumResponse(threePillars, input);
  assert.equal(result.chartBasis, "three_pillars");
  assert.equal(result.chart.hour, null);
  assert.deepEqual(result.chart.day, { stem: "im", branch: "sin" });
  assert.deepEqual(result.analysis.elementBalance?.values, { wood: 1, fire: 1, earth: 2, metal: 1, water: 1 });
  assert.equal(result.analysis.elementBalance?.unit, "surface_character_count");
  assert.equal(result.analysis.yongshin?.primary, "water");
  assert.equal(result.analysis.yongshin?.selectionMethod, "balancing");
  assert.deepEqual(result.analysis.yongshin?.secondary, ["metal"]);
  assert.equal(result.analysis.yongshin?.balancingPrimary, "water");
  assert.equal(result.analysis.yongshin?.climatePrimary, "fire");
  assert.equal(result.analysis.yongshin?.roles?.gishin, "earth");
  assert.deepEqual(result.analysis.yongshin?.elementStates?.water, { count: 1, state: "lack", effect: "positive" });
  assert.equal(result.analysis.strength?.score, -53);
  assert.equal(result.analysis.strength?.result, "weak");
  assert.equal(result.analysis.strength?.providerResult, "신약");
  assert.equal(result.analysis.strength?.level, "중약");
  assert.deepEqual(result.analysis.strength?.root, { rooted: true, score: 11 });
  assert.deepEqual(result.analysis.strength?.breakdown, threePillars.data.strength.breakdown);
  assert.equal(result.calculation.profileId, "hrum_no_location_traditional_v1");
  assert.equal(result.calculation.dayBoundary, "zi_hour_start");
});

test("unknown provider method and strength classification remain unmapped with their source labels", () => {
  const result = normalizeHrumResponse(withData({
    yongshinDetail: { ...threePillars.data.yongshinDetail, method: "새로운방법" },
    strength: { ...threePillars.data.strength, result: "새로운분류", level: "새로운세부값" },
  }), input);
  assert.equal(result.analysis.yongshin?.selectionMethod, "unmapped");
  assert.equal(result.analysis.yongshin?.providerMethod, "새로운방법");
  assert.equal(result.analysis.strength?.result, "unmapped");
  assert.equal(result.analysis.strength?.providerResult, "새로운분류");
  assert.equal(result.analysis.strength?.level, "새로운세부값");
  assert.ok(result.limitations.some((text) => text.includes("매칭 입력으로 사용할 수 없습니다")));
  const reservedLabel = normalizeHrumResponse(withData({
    yongshinDetail: { ...threePillars.data.yongshinDetail, method: "__proto__" },
    strength: { ...threePillars.data.strength, result: "constructor" },
  }), input);
  assert.equal(reservedLabel.analysis.yongshin?.selectionMethod, "unmapped");
  assert.equal(reservedLabel.analysis.strength?.result, "unmapped");
});

test("missing or null detailed analyses remain unavailable rather than fabricated", () => {
  for (const absent of [null, undefined]) {
    const result = normalizeHrumResponse(withData({ yongshinDetail: absent, strength: absent }), input);
    assert.equal(result.analysis.yongshin, null);
    assert.equal(result.analysis.strength, null);
    assert.equal(result.limitations.filter((text) => text.includes("제공하지 않았습니다")).length, 2);
  }
});

test("optional detailed roles, element states, breakdown and root remain null when absent", () => {
  const result = normalizeHrumResponse(withData({
    yongshinDetail: { ...threePillars.data.yongshinDetail, shin: undefined, element_states: null },
    strength: { ...threePillars.data.strength, breakdown: undefined, root: null },
  }), input);
  assert.equal(result.analysis.yongshin?.roles, null);
  assert.equal(result.analysis.yongshin?.elementStates, null);
  assert.equal(result.analysis.strength?.breakdown, null);
  assert.equal(result.analysis.strength?.root, null);
});

test("unconsented, unspecified-sex, ambiguous-boundary and unconfigured calls never leave the server", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("must never call"); };
  for (const [value, apiKey, reasonCode] of [
    [{ ...input, externalProviderConsent: undefined }, key, "EXTERNAL_CONSENT_REQUIRED"],
    [{ ...input, providerSex: "unspecified" as const }, key, "PROVIDER_INPUT_UNSUPPORTED"],
    [{ ...input, calculationOptions: { ...input.calculationOptions, dayBoundary: "late_zi" as const } }, key, "PROVIDER_INPUT_UNSUPPORTED"],
    [input, "", "PROVIDER_NOT_CONFIGURED"],
  ] as const) {
    const result = await createHrumFortuneProvider({ apiKey, fetcher }).calculate(value, { signal: signal() });
    assert.equal(result.status, "not_ready");
    if (result.status === "not_ready") assert.equal(result.reasonCode, reasonCode);
  }
  assert.equal(calls, 0);
});

test("unknown codes, mismatched analyses and wrong surface counts reject the entire provider result", async () => {
  const cases = [
    { wonkuk: { ...threePillars.data.wonkuk, day: { stem: "unknown", branch: "신" } } },
    { wonkuk: { ...threePillars.data.wonkuk, year: { stem: "기", branch: "unknown" } } },
    { yongshin: "unknown" },
    { yongshin: "목" },
    { yongshinDetail: { ...threePillars.data.yongshinDetail, secondary: ["unknown"] } },
    { yongshinDetail: { ...threePillars.data.yongshinDetail, shin: { ...threePillars.data.yongshinDetail.shin, yongshin: "목" } } },
    { ohaengBalance: { ...threePillars.data.ohaengBalance, 목: 2 } },
    { ohaengBalance: { ...threePillars.data.ohaengBalance, 목: 1.5, 화: 0.5 } },
    { strength: { ...threePillars.data.strength, score: 101 } },
    { strength: { ...threePillars.data.strength, dayMaster: "갑" } },
    { yongshinDetail: { ...threePillars.data.yongshinDetail, element_states: { ...threePillars.data.yongshinDetail.element_states, 목: { count: 4, state: "lack", effect: "neutral" } } } },
  ];
  for (const changes of cases) {
    const result = await calculate(withData(changes));
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
  }
});

test("unknown-time results require a verifiable three-pillar marker and no synthetic hour", async () => {
  for (const changes of [
    { birthHour: undefined },
    { birthHour: { ...threePillars.data.birthHour, known: true } },
    { birthHour: { ...threePillars.data.birthHour, basis: "four_pillars" } },
    { birthHour: { ...threePillars.data.birthHour, hourPillar: undefined } },
    { wonkuk: { ...threePillars.data.wonkuk, hour: fourPillars.data.wonkuk.hour } },
  ]) assert.equal((await calculate(withData(changes))).status, "error");
  assert.equal((await calculate({ ...fourPillars, data: { ...fourPillars.data, birthHour: threePillars.data.birthHour } }, { ...input, birthTime: "14:30" })).status, "error");
  assert.equal((await calculate(threePillars, { ...input, birthTime: "14:30" })).status, "error");
});

test("timezone fallback warnings and unexpected true-solar corrections fail closed", async () => {
  for (const payload of [
    { ...threePillars, warnings: [{ code: "UNKNOWN_TIMEZONE" }] },
    withData({ warnings: ["UNKNOWN_TIMEZONE"] }),
    withData({ warnings: [{ code: "NEW_PROVIDER_WARNING" }] }),
    withData({ trueSolarTime: { totalCorrectionMinutes: -32 } }),
  ]) {
    const result = await calculate(payload);
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
  }
});

test("provider additions and private raw fields are stripped from normalized results", () => {
  const result = normalizeHrumResponse({
    ...threePillars, raw: "private-raw-data", account: key,
    data: { ...threePillars.data, birthDate: input.birthDate, extra: "private-raw-data", strength: { ...threePillars.data.strength, account: key } },
  }, input);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes(input.birthDate), false);
  assert.equal(serialized.includes("private-raw-data"), false);
  assert.equal("guestRemaining" in result, false);
});

test("upstream status codes map to sanitized failures with no retry or guest/mock fallback", async () => {
  for (const [status, code, retryable] of [
    [400, "PROVIDER_INPUT_REJECTED", false], [401, "PROVIDER_AUTH_FAILED", false], [403, "PROVIDER_AUTH_FAILED", false],
    [402, "PROVIDER_QUOTA_EXCEEDED", false], [429, "PROVIDER_RATE_LIMITED", true], [500, "PROVIDER_UNAVAILABLE", true],
  ] as const) {
    let calls = 0;
    const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async () => { calls++; return new Response(`private-raw-data ${key}`, { status }); } });
    const result = await provider.calculate(input, { signal: signal() });
    assert.equal(calls, 1);
    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.equal(result.code, code);
      assert.equal(result.retryable, retryable);
    }
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(result).includes("private-raw-data"), false);
  }
});

test("malformed JSON, success false and absent core data cannot appear as a successful result", async () => {
  for (const response of [new Response("<html>private-provider-error</html>"), Response.json({ success: false, data: threePillars.data }), Response.json({ success: true, data: {} })]) {
    const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async () => response });
    const result = await provider.calculate(input, { signal: signal() });
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
    assert.equal(JSON.stringify(result).includes("private-provider-error"), false);
  }
});

test("both declared and streamed responses exceeding two MiB are rejected", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const result = await createHrumFortuneProvider({ apiKey: key, fetcher: async () => response }).calculate(input, { signal: signal() });
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, "INVALID_PROVIDER_RESPONSE");
  }
});

test("abort signals stop the provider request and produce a sanitized timeout", async () => {
  const controller = new AbortController();
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error(`private-error ${key}`)), { once: true });
  }) });
  const pending = provider.calculate(input, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("already-aborted calls never use the network; thrown fetch errors never expose upstream text", async () => {
  let calls = 0;
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async () => { calls++; throw new Error(`${key} private-raw-data`); } });
  const controller = new AbortController();
  controller.abort();
  const aborted = await provider.calculate(input, { signal: controller.signal });
  assert.equal(calls, 0);
  assert.equal(aborted.status, "error");
  if (aborted.status === "error") assert.equal(aborted.code, "PROVIDER_TIMEOUT");
  const result = await provider.calculate(input, { signal: signal() });
  assert.equal(calls, 1);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PROVIDER_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes(key), false);
});

test("an abort while reading a stalled response body cancels the reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull() { controller.abort(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const provider = createHrumFortuneProvider({ apiKey: key, fetcher: async () => response });
  const result = await provider.calculate(input, { signal: controller.signal });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PROVIDER_TIMEOUT");
  assert.equal(cancelled, true);
});
