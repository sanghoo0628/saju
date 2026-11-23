import { defineConfig } from "vitest/config";
import { fileURLToPath } from 'node:url';
// Native multi-connection PostgreSQL tests run separately: npm run test:postgres.
// C's node:test suite is executed by test:payments, not Vitest.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/a/**", "tests/integration/postgres-repository.test.ts"],
  },
});
