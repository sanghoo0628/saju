# HRUM response fixtures

Captured on 2026-11-16 from HRUM's documented public guest playground, using invented test inputs only: solar 2000-01-15, Asia/Seoul, male; birth time omitted for `three-pillars.json`, 14:30 for `four-pillars.json`. No API key, real person's birth data, account ID, IP address, or usage quota is included.

These are recorded real guest calculation responses, trimmed to the fields consumed by the adapter. They are not locally invented astrology results. Extra fields from the response were removed; normalization values were not changed. Production calls use the authenticated partner endpoint only. The fixtures verify parsing, not the availability, billing, or equality of a live partner response. Automated tests make no external requests.

Contract sources: [API documentation](https://hrum.ai/docs.html), [manseryeok API](https://hrum.ai/manseryeok-api.html). HRUM does not publish a manseryeok engine version in the response. A future provider change requires reviewing and updating the adapter contract and fixtures.
