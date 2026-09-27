export default {
  mutate: ["src/config.ts", "src/redirect.ts", "src/session-recovery.ts"],
  buildCommand: "npm run build",
  testRunner: "tap",
  tap: {
    testFiles: ["test/**/*.test.mjs"],
    forceBail: true,
  },
  checkers: ["typescript"],
  tsconfigFile: "tsconfig.json",
  coverageAnalysis: "perTest",
  incremental: true,
  incrementalFile: "reports/stryker-focused-incremental.json",
  thresholds: {
    high: 100,
    low: 99,
    break: 99,
  },
  reporters: ["progress", "clear-text"],
};
