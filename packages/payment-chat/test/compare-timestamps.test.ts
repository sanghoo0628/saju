import test from "node:test";
import assert from "node:assert/strict";
import { compareTimestamps } from "../src/compare-timestamps.ts";

test("microsecond and finer differences survive Date.parse millisecond ties", () => {
  for (const [earlier, later] of [["000001", "000002"], ["123456", "123457"], ["000000001", "000000002"]]) {
    const a = `2026-11-23T00:00:00.${earlier}Z`, b = `2026-11-23T00:00:00.${later}Z`;
    assert.equal(Date.parse(a), Date.parse(b));
    assert.ok(compareTimestamps(a, b) < 0);
    assert.ok(compareTimestamps(b, a) > 0);
  }
});
test("UTC offsets and date boundaries are compared as instants", () => {
  assert.ok(compareTimestamps("2026-11-23T09:00:00.000001+09:00", "2026-11-23T00:00:00.000002Z") < 0);
  assert.equal(compareTimestamps("2026-11-23T00:00:00.123456Z", "2026-11-22T19:00:00.123456-05:00"), 0);
});
test("omitted and trailing fractional zeros do not invent time differences", () => {
  for (const [a, b] of [["00Z", "00.000000Z"], ["00.1Z", "00.100000Z"], ["00.1234Z", "00.123400000Z"]])
    assert.equal(compareTimestamps(`2026-11-23T00:00:${a}`, `2026-11-23T00:00:${b}`), 0);
});
test("whole milliseconds take precedence over fractional suffixes", () => {
  assert.ok(compareTimestamps("2026-11-23T00:00:00.000999Z", "2026-11-23T00:00:00.001000Z") < 0);
  assert.ok(compareTimestamps("2026-11-23T23:59:59.999999Z", "2026-11-24T00:00:00.000001Z") < 0);
});
