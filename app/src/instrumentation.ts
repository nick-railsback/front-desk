// Runs once when the Next server starts: applies pending database migrations
// before any request is served. The dynamic import keeps pg out of the edge
// runtime.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { migrate } = await import('./db/sandbox');
    await migrate();
  }
}
