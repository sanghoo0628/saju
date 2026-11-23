import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/payment-chat-ui/test/**/*.test.ts"],
  },
});
