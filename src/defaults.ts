import type { RunnerConfig } from "./types.js";

export const defaultRunnerConfig: RunnerConfig = {
  headless: false,
  releaseWindowRefreshIntervalMs: 1500,
  normalRefreshIntervalMs: 15 * 60 * 1000,
  releaseWindowBeforeMs: 10000,
  releaseWindowAfterMs: 120000,
  maxAttempts: 0
};
