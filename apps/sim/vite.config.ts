import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: api, ws: true, changeOrigin: true } },
  },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 6000 },
});
