import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    globalSetup: ["./e2e/global-setup.ts"],
    // One API process and one database for the whole run
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
