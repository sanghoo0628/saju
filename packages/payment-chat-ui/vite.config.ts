import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { demoApi } from "./demo/server.ts";

export default defineConfig({
  plugins: [react(), demoApi()],
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
