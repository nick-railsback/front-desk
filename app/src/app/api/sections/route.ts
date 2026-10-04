// POST /api/sections: saves one section into the cookie's sandbox's draft
// (PRD O6, O8). A draft change reaches no parent until it is published. A
// refused or failed save leaves the draft as it was, and no response carries
// error detail. Never calls the model.

import { z } from 'zod';
import { forSandbox } from '../../../db/sandbox';
import { denverDate } from '../../../seed/dates';
import { sandboxFromCookie } from '../../../server/sandbox-cookie';

export const dynamic = 'force-dynamic';

const Body = z.object({
  id: z.string().min(1).nullish(),
  // Saved exactly as entered; a title must hold more than whitespace.
  title: z.string().max(80).regex(/\S/),
  visibility: z.enum(['parent', 'staff']),
  text: z.string().max(4000),
});

export async function POST(request: Request): Promise<Response> {
  const body = Body.safeParse(await request.json().catch(() => null));
  const sandboxId = sandboxFromCookie(request.headers.get('cookie'));
  if (!body.success || !sandboxId) return Response.json({ error: 'invalid' }, { status: 400 });
  try {
    const now = new Date();
    const access = forSandbox(sandboxId);
    // A deleted sandbox gets the same answer as a missing cookie.
    if (!(await access.seen(now))) return Response.json({ error: 'invalid' }, { status: 400 });
    const { id, ...fields } = body.data;
    const section = await access.saveSection({ ...fields, id: id ?? null }, denverDate(now));
    if (!section) return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json({ section });
  } catch (err) {
    console.error('POST /api/sections failed:', err);
    return Response.json({ error: 'save_failed' }, { status: 500 });
  }
}
