import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude the re-export barrel (exercised by the API smoke test), CLI
      // entrypoints (process.argv/stdout glue), and static fixture/eval data.
      exclude: [
        "src/index.ts",
        "src/cli.ts",
        "src/eval/cli.ts",
        "src/cost/cli.ts",
        "src/server/cli.ts",
        "src/fixtures/**",
        "src/eval/dataset.ts",
      ],
      // Quality is enforced, not just reported: `test:coverage` (and CI) fail
      // below these floors. Raised further as the eval harness lands in Phase 2.
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
});
