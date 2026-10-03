// Send to front desk.
//
// send to front desk: activating it on a stored reply marks that reply as
// sent in its sandbox and replaces the control with "Sent to the front desk."
// A repeated send leaves the record unchanged and the control does not come
// back. A send naming a reply of another sandbox changes nothing.
//
// Assumed interface: see ./support.ts (POST /api/send, turns.sent_to_front_desk).

import { expect, test } from '@playwright/test';
import { SENT_TEXT, ask, conversation, isSent, open, sandboxId, sendToFrontDesk, turnsWith, unique } from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

test.describe('send to front desk', () => {
  test('marks the reply once, in its own sandbox only', async ({ page, browser }) => {
    await open(page);
    const message = unique('Do you have a swimming pool?');
    await ask(page, message);
    const owner = await sandboxId(page.context());
    const [turn] = await turnsWith(message);
    expect(turn?.sandbox_id, 'the reply was not stored in the sandbox that sent it').toBe(owner);
    expect(isSent(turn.row), 'the reply is marked sent before anyone sent it').toBe(false);

    // Another sandbox names this reply first: nothing changes.
    const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      const otherPage = await other.newPage();
      await open(otherPage);
      expect(await sandboxId(other), "the second browser got the first browser's sandbox").not.toBe(owner);
      const foreign = await other.request.post('/api/send', { data: { replyId: turn.id } });
      expect(foreign.status(), "a send for another sandbox's reply was not answered").toBe(200);
      expect(await foreign.json(), "a send for another sandbox's reply reported a change").toEqual({ sent: false });
    } finally {
      await other.close();
    }
    const [afterForeign] = await turnsWith(message);
    expect(afterForeign.row, 'a send from another sandbox changed the reply').toEqual(turn.row);

    const log = conversation(page);
    const control = sendToFrontDesk(log);
    await expect(control).toBeVisible();
    const request = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/send');
    await control.click();
    expect((await request).postDataJSON(), 'Send to front desk did not name the stored reply').toEqual({ replyId: turn.id });
    await expect(log.getByText(SENT_TEXT), 'the control was not replaced with the sent confirmation').toBeVisible();
    await expect(sendToFrontDesk(page), 'Send to front desk is still offered after sending').toHaveCount(0);

    const [sent] = await turnsWith(message);
    expect(isSent(sent.row), 'the reply is not marked sent').toBe(true);

    const again = await page.request.post('/api/send', { data: { replyId: turn.id } });
    expect(again.status()).toBe(200);
    expect(await again.json(), 'a repeated send reported a change').toEqual({ sent: false });
    const [afterRepeat] = await turnsWith(message);
    expect(afterRepeat.row, 'a repeated send changed the record').toEqual(sent.row);
    await expect(sendToFrontDesk(page), 'Send to front desk came back after a repeated send').toHaveCount(0);
    await expect(log.getByText(SENT_TEXT)).toBeVisible();
  });
});
