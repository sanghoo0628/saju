import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/postgres-repository.test.ts"],
    testTimeout: 30000,
  },
});
