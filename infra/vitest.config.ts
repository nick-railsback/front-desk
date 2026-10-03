import { defineConfig } from 'vitest/config';

// The first test in each file synthesizes the whole stack, which can take
// more than vitest's 5 s default on a loaded CI runner.
export default defineConfig({ test: { testTimeout: 30_000 } });
