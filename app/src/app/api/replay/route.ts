// GET /api/replay: the progress of the cookie's sandbox's latest replay, which
// the operator view polls while it runs (PRD O11). With no replay yet, nothing
// is running.

import { forSandbox } from '../../../db/sandbox';
import { sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const sandboxId = sandboxFromCookie(request.headers.get('cookie'));
  if (!sandboxId) return Response.json({ error: 'invalid' }, { status: 400 });
  try {
    const replay = await forSandbox(sandboxId).latestReplay();
    return Response.json({
      running: replay?.status === 'running',
      failed: replay?.status === 'failed',
      completed: replay?.completed ?? 0,
      total: replay?.total ?? 0,
    });
  } catch (err) {
    console.error('GET /api/replay failed:', err);
    return Response.json({ error: 'replay_failed' }, { status: 500 });
  }
}
