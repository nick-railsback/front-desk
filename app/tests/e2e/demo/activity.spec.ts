// Activity: every request carrying a sandbox's cookie records activity for
// that sandbox. Each kind of request is sent with the cookie of a sandbox
// whose last activity was set 3 days back, and afterwards its last activity
// is the time of that request: loading the parent view, loading the
// operator view, asking a question, sending a reply to the front desk,
// saving a section, publishing, and reading replay progress.
//
// Assumed interface: see ./support.ts (4).

import { type APIRequestContext, expect, test } from '@playwright/test';
import { lastSeen, setLastSeen } from '../../demo/tables';
import { DAY, closeSql, cookieOf, letters } from './support';

test.describe.configure({ timeout: 180_000 });
test.afterAll(closeSql);

type Kind = { name: string; send: (request: APIRequestContext, ready: { replyId: string }) => Promise<{ status: () => number }> };

const KINDS: Kind[] = [
  { name: 'loading the parent view', send: (r) => r.get('/') },
  { name: 'loading the operator view', send: (r) => r.get('/operator') },
  { name: 'asking a question', send: (r) => r.post('/api/ask', { data: { message: 'When is breakfast served?', priorTurns: [] } }) },
  { name: 'sending a reply to the front desk', send: (r, ready) => r.post('/api/send', { data: { replyId: ready.replyId } }) },
  {
    name: 'saving a section',
    send: (r) => r.post('/api/sections', { data: { id: null, title: `Pottery class ${letters(8)}`, visibility: 'parent', text: 'Saturdays at 10:00 AM.' } }),
  },
  { name: 'publishing', send: (r) => r.post('/api/publish') },
  { name: 'reading replay progress', send: (r) => r.get('/api/replay') },
];

test.describe('activity', () => {
  for (const kind of KINDS) {
    test(`${kind.name} records activity for the cookie's sandbox`, async ({ context }) => {
      const request = context.request;
      expect((await request.get('/')).status(), 'the parent view did not load').toBe(200);
      const id = await cookieOf(context);
      const asked = await request.post('/api/ask', { data: { message: 'fixture:not_in_source Do you have a swimming pool?', priorTurns: [] } });
      const replyId = (await asked.json())?.replyId;
      expect(typeof replyId, 'no stored reply to send to the front desk').toBe('string');

      const then = new Date(Date.now() - 3 * DAY);
      await setLastSeen(id, then);
      const start = Date.now();
      const response = await kind.send(request, { replyId });
      expect(response.status(), `${kind.name} failed`).toBeLessThan(400);
      expect(await cookieOf(context), `${kind.name} moved the browser to another sandbox`).toBe(id);
      const seen = await lastSeen(id);
      expect(seen, 'the sandbox is gone').not.toBeNull();
      expect(seen!.getTime(), `${kind.name} recorded no activity: last activity is still ${seen!.toISOString()}`).toBeGreaterThan(then.getTime() + DAY);
      expect(seen!.getTime(), `${kind.name} recorded activity at ${seen!.toISOString()}, before the request`).toBeGreaterThanOrEqual(start - 5_000);
      expect(seen!.getTime(), `${kind.name} recorded activity at ${seen!.toISOString()}, after the request`).toBeLessThanOrEqual(Date.now() + 5_000);
    });
  }
});
