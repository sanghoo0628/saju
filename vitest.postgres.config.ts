import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/postgres-repository.test.ts", "tests/integration/groble-inbox.test.ts"],
    testTimeout: 30000,
  },
});
