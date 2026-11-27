import { defineConfig } from "vitest/config";
import { fileURLToPath } from 'node:url';
// Native multi-connection PostgreSQL tests run separately: npm run test:postgres.
// C's node:test suite is executed by test:payments, not Vitest.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/a/**", "tests/integration/postgres-repository.test.ts", "tests/integration/groble-inbox.test.ts", "tests/integration/groble-module.test.ts", "tests/integration/chat-recovery.test.ts", "tests/integration/birth-input-concurrency.test.ts", "tests/integration/fortune-quota-concurrency.test.ts"],
    // tests/db 는 파일마다 PGlite 를 띄우고 마이그레이션을 전부 적용한다.
    // 병렬 실행으로 느려지면 beforeAll 이 기본 10초를 넘길 수 있어 준비 시간만 늘린다.
    hookTimeout: 60_000,
  },
});
