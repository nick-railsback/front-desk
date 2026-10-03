// POST /api/publish: publishes the cookie's sandbox's draft as the next
// snapshot (PRD O9) and starts the replay of its open gaps (O10). The replay
// runs on in this process after the response; the operator view follows it
// through GET /api/replay. A failed publish creates no snapshot, and no
// response carries error detail.

import { forSandbox } from '../../../db/sandbox';
import { realClock } from '../../../server/clock';
import { getModel } from '../../../server/model';
import { runReplay } from '../../../server/replay';
import { sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const sandboxId = sandboxFromCookie(request.headers.get('cookie'));
  if (!sandboxId) return Response.json({ error: 'invalid' }, { status: 400 });
  try {
    const { version, replayId, total } = await forSandbox(sandboxId).publish(new Date());
    if (total > 0) void runReplay(sandboxId, replayId, { model: getModel(), clock: realClock });
    return Response.json({ version });
  } catch (err) {
    console.error('POST /api/publish failed:', err);
    return Response.json({ error: 'publish_failed' }, { status: 500 });
  }
}
