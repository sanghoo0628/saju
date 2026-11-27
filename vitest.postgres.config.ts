import { fileURLToPath } from 'node:url';
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ["tests/integration/postgres-repository.test.ts", "tests/integration/groble-inbox.test.ts", "tests/integration/groble-module.test.ts", "tests/integration/chat-recovery.test.ts"],
    testTimeout: 30000,
  },
});
