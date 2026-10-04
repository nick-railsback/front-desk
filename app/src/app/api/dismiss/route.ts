// POST /api/dismiss: hides the Try this strip for the cookie's sandbox on
// both views (PRD D5). Dismissal belongs to the sandbox, so it holds across
// reloads and views, and Reset demo brings the strip back. No response
// carries error detail.

import { forSandbox } from '../../../db/sandbox';
import { sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  try {
    const sandboxId = sandboxFromCookie(request.headers.get('cookie'));
    const now = new Date();
    const access = sandboxId ? forSandbox(sandboxId) : null;
    if (!access || !(await access.seen(now)) || !(await access.dismissTryThis(now))) {
      return Response.json({ error: 'dismiss_failed' }, { status: 500 });
    }
    return Response.json({ dismissed: true });
  } catch (err) {
    console.error('POST /api/dismiss failed:', err);
    return Response.json({ error: 'dismiss_failed' }, { status: 500 });
  }
}
