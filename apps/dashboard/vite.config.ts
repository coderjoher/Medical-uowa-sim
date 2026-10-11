import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  base: "/staff/",
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": { target: api, ws: true, changeOrigin: true } } },
  build: { target: "es2022" },
});
