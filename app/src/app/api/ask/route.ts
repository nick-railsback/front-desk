// POST /api/ask: one parent message. Picks the sandbox from its cookie,
// creating one when the cookie is missing or stale, and always answers with a
// reply: any failure becomes the fixed system_error handoff, with its detail
// in the log and never in the response. Alongside the reply: its stored turn
// ID, for Send to front desk (null when it was not stored), and the sections
// it cites, for the parent view's citation chips.

import { z } from 'zod';
import { fixedReply } from '../../../core/answer';
import type { CitedSection, Reply } from '../../../core/types';
import { createSandbox, forSandbox } from '../../../db/sandbox';
import { ask } from '../../../server/ask';
import { realClock } from '../../../server/clock';
import { getModel } from '../../../server/model';
import { sandboxCookie, sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

const Body = z.object({
  message: z.string().trim().min(1),
  priorTurns: z.array(z.object({ role: z.enum(['parent', 'front_desk']), text: z.string() })).catch([]),
});

function respond(body: { reply: Reply; replyId: string | null; sections: CitedSection[] }, sandboxId: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (sandboxId) headers.append('set-cookie', sandboxCookie(sandboxId));
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  let created: string | null = null;
  try {
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: 'bad_request' }, { status: 400 });
    let sandboxId = sandboxFromCookie(request.headers.get('cookie'));
    if (!sandboxId || !(await forSandbox(sandboxId).exists())) {
      sandboxId = created = await createSandbox(now);
    }
    const result = await ask({ sandboxId, message: body.data.message, priorTurns: body.data.priorTurns, now }, { model: getModel(), clock: realClock });
    return respond({ reply: result.reply, replyId: result.replyId, sections: result.cited }, created);
  } catch (err) {
    console.error('POST /api/ask failed:', err);
    // Weekdays and office hours alone: the calendar may be what failed.
    return respond({ reply: fixedReply('system_error', now, [], 0), replyId: null, sections: [] }, created);
  }
}
