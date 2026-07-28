import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["electron/**/*.test.ts", "src/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: ["electron/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "**/*.test.ts",
        "electron/main.ts",
        // Type-only module (interfaces and type aliases); there is no runtime code to cover.
        "electron/trace-model.ts",
        // Process entry points are exercised by the Runtime smoke test/build rather
        // than loaded into the Vitest process (doing so would register process IPC handlers).
        "electron/agent-runtime-worker.ts",
        "electron/agent-runtime-protocol.ts",
        // Electron WebContents integration and injected page scripts require the
        // packaged-app E2E lane; unit coverage remains focused on deterministic services.
        "electron/browser-service.ts",
        "electron/browser-annotation-script.ts",
        "src/App.tsx",
        "src/components/**/*.tsx",
        "src/global.d.ts",
        "src/main.tsx",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
