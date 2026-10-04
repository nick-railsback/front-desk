// POST /api/reset: Reset demo (PRD D2). Gives the browser a fresh sandbox and
// deletes the old one with all its data, in this request. The new sandbox is
// created first, so a failed delete leaves the browser in its old sandbox;
// the orphaned new one is collected by the idle deletion. No response
// carries error detail.

import { createSandbox, deleteSandbox } from '../../../db/sandbox';
import { sandboxCookie, sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const old = sandboxFromCookie(request.headers.get('cookie'));
    const fresh = await createSandbox(new Date());
    if (old) await deleteSandbox(old);
    return Response.json({ ok: true }, { headers: { 'set-cookie': sandboxCookie(fresh) } });
  } catch (err) {
    console.error('POST /api/reset failed:', err);
    return Response.json({ error: 'reset_failed' }, { status: 500 });
  }
}
