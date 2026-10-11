import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: api, ws: true, changeOrigin: true }, "/media": { target: api, changeOrigin: true } },
  },
  // Classic worker: MediaPipe loads its WebAssembly glue with importScripts, which module workers lack.
  worker: { format: "iife" },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 6000 },
});
