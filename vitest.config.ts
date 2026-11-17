import { defineConfig } from "vitest/config";
// Native multi-connection PostgreSQL tests run separately: npm run test:postgres.
// C's node:test suite is executed by test:payments, not Vitest.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/postgres-repository.test.ts"],
  },
});
