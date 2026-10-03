// First visit (PRD D1): gives a browser without a valid sandbox cookie its own
// sandbox before the parent view renders, and sets the cookie on the page's
// own response. A server component cannot set cookies, so this runs here.
// The page reads the sandbox from the x-fd-sandbox request header, which only
// this proxy sets: any copy the browser sent is dropped.

import { type NextRequest, NextResponse } from 'next/server';
import { createSandbox, forSandbox } from './db/sandbox';
import { SANDBOX_HEADER, sandboxCookie, sandboxFromCookie } from './server/sandbox-cookie';

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const headers = new Headers(request.headers);
  headers.delete(SANDBOX_HEADER);
  try {
    let sandboxId = sandboxFromCookie(request.headers.get('cookie'));
    let created = false;
    if (!sandboxId || !(await forSandbox(sandboxId).exists())) {
      sandboxId = await createSandbox(new Date());
      created = true;
    }
    headers.set(SANDBOX_HEADER, sandboxId);
    const response = NextResponse.next({ request: { headers } });
    if (created) response.headers.append('set-cookie', sandboxCookie(sandboxId));
    return response;
  } catch (err) {
    // The page renders its unavailable message when no sandbox reaches it.
    console.error('proxy: no sandbox for the parent view:', err);
    return NextResponse.next({ request: { headers } });
  }
}

export const config = { matcher: '/' };
