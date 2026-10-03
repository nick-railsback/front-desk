// POST /api/send: Send to front desk (PRD P9). Marks one stored reply of the
// cookie's sandbox as sent. `sent` is true only when this request set the
// mark; a repeat, an unknown ID, or another sandbox's reply changes nothing.
// Never creates a sandbox, and never puts error detail in the response.

import { z } from 'zod';
import { forSandbox } from '../../../db/sandbox';
import { sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

const Body = z.object({ replyId: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: 'bad_request' }, { status: 400 });
  try {
    const sandboxId = sandboxFromCookie(request.headers.get('cookie'));
    if (!sandboxId) return Response.json({ sent: false });
    return Response.json({ sent: await forSandbox(sandboxId).markSent(body.data.replyId, new Date()) });
  } catch (err) {
    console.error('POST /api/send failed:', err);
    return Response.json({ sent: false });
  }
}
