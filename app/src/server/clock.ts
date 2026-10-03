// The real clock, for the route and the eval CLI. Core never reads time.

import type { Clock } from '../core/types';

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
