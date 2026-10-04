// Runs before the parent and operator views render, for two things.
//
// First visit (PRD D1): gives a browser without a valid sandbox cookie its own
// sandbox, and sets the cookie on the page's own response. A server component
// cannot set cookies, so this runs here. The page reads the sandbox from the
// x-fd-sandbox request header, which only this proxy sets: any copy the
// browser sent is dropped. A valid cookie records activity for its sandbox.
//
// Content-Security-Policy (PRD S11): scripts only from the app's own origin
// and a nonce made for this response. Next reads the policy from the request
// headers and puts the nonce on its own scripts.

import { type NextRequest, NextResponse } from 'next/server';
import { createSandbox, forSandbox } from './db/sandbox';
import { SANDBOX_HEADER, sandboxCookie, sandboxFromCookie } from './server/sandbox-cookie';

// `next dev` evaluates code with eval; the production build never does.
function policy(nonce: string): string {
  const evalInDev = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";
  return `script-src 'self' 'nonce-${nonce}'${evalInDev}; frame-ancestors 'none'`;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const csp = policy(btoa(crypto.randomUUID()));
  const headers = new Headers(request.headers);
  headers.delete(SANDBOX_HEADER);
  headers.set('content-security-policy', csp);
  try {
    let sandboxId = sandboxFromCookie(request.headers.get('cookie'));
    let created = false;
    if (!sandboxId || !(await forSandbox(sandboxId).seen(new Date()))) {
      sandboxId = await createSandbox(new Date());
      created = true;
    }
    headers.set(SANDBOX_HEADER, sandboxId);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set('content-security-policy', csp);
    if (created) response.headers.append('set-cookie', sandboxCookie(sandboxId));
    return response;
  } catch (err) {
    // The page renders its unavailable message when no sandbox reaches it.
    console.error('proxy: no sandbox for the view:', err);
    const response = NextResponse.next({ request: { headers } });
    response.headers.set('content-security-policy', csp);
    return response;
  }
}

export const config = { matcher: ['/', '/operator'] };
