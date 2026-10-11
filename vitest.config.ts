import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // API integration tests share one database; run files sequentially.
    fileParallelism: false,
  },
});
