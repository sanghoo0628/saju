import { defineConfig } from "vitest/config";
// B의 Vitest와 C의 node:test를 서로의 테스트 러너로 실행하지 않는다.
export default defineConfig({ test:{ include:["tests/**/*.test.ts"] } });
