// POST /api/ask: one parent message. Picks the sandbox from its cookie,
// creating one when the cookie is missing or stale, and always answers with a
// reply: any failure becomes the fixed system_error handoff, with its detail
// in the log and never in the response.

import { z } from 'zod';
import { fixedReply } from '../../../core/answer';
import type { Reply } from '../../../core/types';
import { createSandbox, forSandbox } from '../../../db/sandbox';
import { ask } from '../../../server/ask';
import { realClock } from '../../../server/clock';
import { getModel } from '../../../server/model';

export const dynamic = 'force-dynamic';

const COOKIE = 'fd_sandbox';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Body = z.object({
  message: z.string().trim().min(1),
  priorTurns: z.array(z.object({ role: z.enum(['parent', 'front_desk']), text: z.string() })).catch([]),
});

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function respond(reply: Reply, sandboxId: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (sandboxId) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    headers.append('set-cookie', `${COOKIE}=${sandboxId}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  }
  return new Response(JSON.stringify({ reply }), { status: 200, headers });
}

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  let created: string | null = null;
  try {
    const body = Body.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: 'bad_request' }, { status: 400 });
    let sandboxId = cookieValue(request.headers.get('cookie'), COOKIE);
    if (!sandboxId || !UUID.test(sandboxId) || !(await forSandbox(sandboxId).exists())) {
      sandboxId = created = await createSandbox(now);
    }
    const result = await ask({ sandboxId, message: body.data.message, priorTurns: body.data.priorTurns, now }, { model: getModel(), clock: realClock });
    return respond(result.reply, created);
  } catch (err) {
    console.error('POST /api/ask failed:', err);
    // Weekdays and office hours alone: the calendar may be what failed.
    return respond(fixedReply('system_error', now, [], 0), created);
  }
}
