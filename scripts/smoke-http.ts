import assert from 'node:assert/strict';

// Against an already-running local app, with the intentionally unconfigured .env.example.
async function main() {
const base = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)) throw new Error('Local smoke tests only');
let count = 0;
for (const path of ['/', '/login', '/fortune', '/fortune/result', '/profile', '/matches', '/orders/return', '/requests', '/chat']) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, path);
  assert.match(await response.text(), /사이/);
  count++;
}
const demo = await fetch(`${base}/api/fortune/demo`);
assert.equal(demo.status, 200);
const fixture = await demo.json();
assert.equal(fixture.source, 'mock');
assert.equal(fixture.data.chartBasis, 'three_pillars');
assert.equal(fixture.data.chart.hour, null);
assert.equal(fixture.persistence, 'not_persisted');
assert.match(demo.headers.get('cache-control') ?? '', /no-store/);
count++;
const me = await fetch(`${base}/api/me`);
assert.equal(me.status, 503, 'Run without Supabase keys; this checks honest unconfigured behavior');
assert.equal((await me.json()).error.code, 'SERVICE_NOT_CONFIGURED');
count++;
const crossOrigin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.invalid' }, body: '{"email":"test@example.edu"}' });
assert.equal(crossOrigin.status, 403);
assert.equal((await crossOrigin.json()).error.code, 'INVALID_ORIGIN');
count++;
const webhook = await fetch(`${base}/api/webhooks/groble`, { method: 'POST', redirect: 'manual', body: '{}' });
assert.equal(webhook.status, 503, 'Groble remains unavailable until the official gateway is configured');
assert.equal((await webhook.json()).code, 'PROVIDER_UNAVAILABLE');
assert.equal(webhook.headers.get('location'), null);
count++;
const fortune = await fetch(`${base}/api/fortune`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
assert.equal(fortune.status, 503);
assert.equal((await fortune.json()).error.code, 'SERVICE_NOT_CONFIGURED');
count++;
const matchingBasis = await fetch(`${base}/api/fortune/matching-basis`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: '{}' });
assert.equal(matchingBasis.status, 503);
assert.equal((await matchingBasis.json()).error.code, 'SERVICE_NOT_CONFIGURED');
count++;
for (const path of ['/api/orders/nonexistent', '/api/chat-requests', '/api/conversations']) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROVIDER_UNAVAILABLE');
  count++;
}
for (const path of ['/api/match-results', '/api/profile']) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SERVICE_NOT_CONFIGURED');
  count++;
}
console.log(`PASS ${count} local HTTP checks (no external calls/payments)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
