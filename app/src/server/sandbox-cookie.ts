// The sandbox cookie: which sandbox a browser is in. The proxy sets it on a
// first visit to the page; /api/ask and /api/send read it.

export const SANDBOX_COOKIE = 'fd_sandbox';

// The request header the proxy hands the page the sandbox in.
export const SANDBOX_HEADER = 'x-fd-sandbox';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sandbox ID a Cookie header names, or null when it names none that could
// be one. Whether that sandbox exists is the caller's question.
export function sandboxFromCookie(header: string | null): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SANDBOX_COOKIE) {
      // Not percent-encoded, so never a sandbox ID: a fresh one replaces it.
      const value = part.slice(eq + 1).trim();
      return UUID.test(value) ? value : null;
    }
  }
  return null;
}

// The Set-Cookie value that puts a browser in a sandbox.
export function sandboxCookie(sandboxId: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SANDBOX_COOKIE}=${sandboxId}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
