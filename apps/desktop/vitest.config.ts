import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["electron/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["electron/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "**/*.test.ts",
        "electron/main.ts",
        "src/global.d.ts",
        "src/main.tsx",
      ],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 75,
        lines: 80,
      },
    },
  },
});
