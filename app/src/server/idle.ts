// The idle deletion's daily run (PRD D7): deletes idle sandboxes once at once,
// then once a day, with no visitor request. The clock is injected so a test
// can move it.

import type { Clock } from '../core/types';

const DAY = 86_400_000;

export function scheduleIdleDeletion(deps: { clock: Clock; deleteIdle: (now: Date) => Promise<unknown> }): { stop(): void } {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        await deps.deleteIdle(new Date(deps.clock.now()));
      } catch (err) {
        // A failed run, a database outage for example, waits for the next one.
        console.error('idle deletion failed:', err);
      }
      await deps.clock.sleep(DAY);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
