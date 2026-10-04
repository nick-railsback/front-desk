// Runs once when the Next server starts: applies pending database migrations
// before any request is served, then starts the daily idle deletion. The
// dynamic imports keep pg out of the edge runtime.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { deleteIdleSandboxes, migrate } = await import('./db/sandbox');
    const { realClock } = await import('./server/clock');
    const { scheduleIdleDeletion } = await import('./server/idle');
    await migrate();
    // The timer is unref'd so the daily wait never keeps a process alive on
    // its own. realClock's sleep is not, because the eval CLI awaits it.
    scheduleIdleDeletion({
      clock: { now: realClock.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()) },
      deleteIdle: deleteIdleSandboxes,
    });
  }
}
