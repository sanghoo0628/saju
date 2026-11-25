import assert from "node:assert/strict";
import test from "node:test";
import threePillars from "../fixtures/hrum/three-pillars.json";
import { fortuneInputSchema } from "../../src/features/fortune/schema";
import { createHrumFortuneProvider } from "../../src/features/fortune/providers/hrum";
import { MemoryFortuneCache } from "../../src/features/fortune/cache";
import { calculateFortune } from "../../src/features/fortune/service";
import { calculateFortuneForMatching } from "../../src/features/fortune/matching-input";
import { createSupabaseFortuneQuota, type ClaimProviderCall, type ProviderCallClaim } from "../../src/features/fortune/quota";
import { parseServerEnv } from "../../src/lib/env/schema";

const input = fortuneInputSchema.parse({
  birthDate: "2000-01-15", birthTime: null, timezone: "Asia/Seoul", calendar: "solar", isLeapMonth: false,
  providerSex: "male", consent: true, externalProviderConsent: "hrum_birth_data_v1",
});
const userId = "aeb013eb-7816-424f-9a60-f60bb104ec33";
const secret = "test-only-fingerprint-secret-never-for-production";

function setup(decisions: Array<ProviderCallClaim | Error>, fetchResult: () => Promise<Response> = async () => Response.json(threePillars)) {
  const log: string[] = [];
  const provider = createHrumFortuneProvider({ apiKey: "test-only-key", fetcher: async () => { log.push("fetch"); return fetchResult(); } });
  const claimProviderCall: ClaimProviderCall = async (id) => {
    assert.equal(id, userId);
    log.push("claim");
    const next = decisions.shift() ?? "ok";
    if (next instanceof Error) throw next;
    return next;
  };
  return { log, options: { userId, provider, fingerprintSecret: secret, cache: new MemoryFortuneCache(), claimProviderCall } };
}

test("a billed call claims the quota once, right before the HRUM request", async () => {
  const { log, options } = setup(["ok"]);
  const result = await calculateFortune(input, options);
  assert.equal(result.status, "ready");
  assert.deepEqual(log, ["claim", "fetch"]);
});

test("cache reuse does not consume the daily quota", async () => {
  const { log, options } = setup(["ok", "ok"]);
  await calculateFortune(input, options);
  const again = await calculateFortune(input, options);
  assert.equal(again.status, "ready");
  if (again.status === "ready") assert.equal(again.cached, true);
  assert.deepEqual(log, ["claim", "fetch"]);
});

test("user and project limits stop the call before HRUM and explain it", async () => {
  for (const [decision, code] of [["user_limit", "DAILY_LIMIT_REACHED"], ["total_limit", "SERVICE_DAILY_LIMIT_REACHED"]] as const) {
    const { log, options } = setup([decision]);
    const result = await calculateFortune(input, options);
    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.equal(result.code, code);
      assert.equal(result.retryable, false);
      assert.match(result.message, /오늘/);
    }
    assert.deepEqual(log, ["claim"]);
  }
});

test("a quota DB failure fails closed: no billed request", async () => {
  const { log, options } = setup([new Error("db down")]);
  const result = await calculateFortune(input, options);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PROVIDER_UNAVAILABLE");
  assert.deepEqual(log, ["claim"]);
});

test("failed and timed-out provider calls still count (claim is never refunded)", async () => {
  const { log, options } = setup(["ok", "ok"], async () => new Response("upstream", { status: 503 }));
  const first = await calculateFortune(input, options);
  assert.equal(first.status, "error");
  const second = await calculateFortune(input, options);
  assert.equal(second.status, "error");
  assert.deepEqual(log, ["claim", "fetch", "claim", "fetch"]);
});

test("local prechecks run before claiming, so rejected input costs nothing", async () => {
  const { log, options } = setup(["ok"]);
  for (const changes of [{ providerSex: "unspecified" }, { externalProviderConsent: undefined }]) {
    const result = await calculateFortune(fortuneInputSchema.parse({ ...input, ...changes }), options);
    assert.equal(result.status, "not_ready");
  }
  assert.deepEqual(log, []);
});

test("the matching-basis route path shares the same claim and reports the limit", async () => {
  const { log, options } = setup(["user_limit"]);
  const result = await calculateFortuneForMatching(input, options);
  assert.equal(result.status, "not_ready");
  if (result.status === "not_ready") assert.equal(result.reasonCode, "DAILY_LIMIT_REACHED");
  assert.deepEqual(log, ["claim"]);
});

test("Supabase quota adapter maps RPC results and throws on errors", async () => {
  const calls: unknown[] = [];
  const client = (data: unknown, error: unknown = null) => ({
    rpc: async (name: string, args: unknown) => { calls.push([name, args]); return { data, error }; },
  }) as never;
  const limits = { userLimit: 5, totalLimit: 15 };
  for (const value of ["ok", "user_limit", "total_limit"] as const) {
    assert.equal(await createSupabaseFortuneQuota(() => client(value), limits)(userId), value);
  }
  assert.deepEqual(calls[0], ["claim_fortune_provider_call", { p_user: userId, p_user_limit: 5, p_total_limit: 15 }]);
  await assert.rejects(createSupabaseFortuneQuota(() => client(null, { message: "boom" }), limits)(userId));
  await assert.rejects(createSupabaseFortuneQuota(() => client("unexpected"), limits)(userId));
  assert.throws(() => createSupabaseFortuneQuota(() => client("ok"), { userLimit: 0, totalLimit: 15 }));
});

test("daily limits default to 5 per user and 15 per project, and reject invalid values", () => {
  const env = parseServerEnv({});
  assert.equal(env.FORTUNE_DAILY_USER_LIMIT, 5);
  assert.equal(env.FORTUNE_DAILY_TOTAL_LIMIT, 15);
  const custom = parseServerEnv({ FORTUNE_DAILY_USER_LIMIT: "3", FORTUNE_DAILY_TOTAL_LIMIT: "" });
  assert.equal(custom.FORTUNE_DAILY_USER_LIMIT, 3);
  assert.equal(custom.FORTUNE_DAILY_TOTAL_LIMIT, 15);
  for (const bad of ["0", "-1", "2.5", "abc"]) {
    assert.throws(() => parseServerEnv({ FORTUNE_DAILY_USER_LIMIT: bad }), /FORTUNE_DAILY_USER_LIMIT/, bad);
  }
});
