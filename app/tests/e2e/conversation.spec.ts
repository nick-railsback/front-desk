// Sending and the conversation.
//
// message length: a 500-character message is sent; at 501 characters an
// inline notice shows, the send control is disabled, and nothing reaches
// /api/ask.
//
// suggested questions: an empty conversation shows 4 to 6; tapping one sends
// its text, and its reply appears.
//
// pending reply: a typing indicator shows and the send control is disabled
// while /api/ask is pending; the reply then appears whole in one update and
// the indicator is gone.
//
// announcements: a live region receives each reply's complete text exactly
// once, never a partial text and never an earlier reply again.
//
// follow-up context: a message carries the last 2 exchanges as prior turns
// and nothing older; New conversation empties the conversation, brings the
// suggested questions back, and the next message carries no prior turns.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page, type Request } from '@playwright/test';
import {
  ANSWERED_TEXT,
  MARKER,
  TRIGGER,
  ask,
  conversation,
  fixedTextOf,
  fragments,
  messageInput,
  newConversation,
  normalize,
  open,
  recordUpdates,
  sendButton,
  suggestions,
  typingIndicator,
  updates,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

type AskBody = { message?: string; priorTurns?: { role: string; text: string }[] };

function askRequests(page: Page): AskBody[] {
  const bodies: AskBody[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/ask') bodies.push((r.postDataJSON() ?? {}) as AskBody);
  });
  return bodies;
}

test.describe('message length', () => {
  test('sends 500 characters and blocks 501 with an inline notice', async ({ page }) => {
    const bodies = askRequests(page);
    await open(page);
    const input = messageInput(page);

    const fiveHundred = 'a'.repeat(500);
    await ask(page, fiveHundred);
    expect(bodies.map((b) => b.message?.length), 'the 500-character message was not sent whole').toEqual([500]);

    // Typed one key past the limit, as a parent would.
    await input.fill('b'.repeat(500));
    await input.press('End');
    await input.pressSequentially('b');
    await expect(input, 'the input refused the 501st character, so the notice can never show').toHaveValue('b'.repeat(501));
    await expect(page.getByText(/500/).filter({ visible: true }).first(), 'no inline notice names the 500-character limit').toBeVisible();
    await expect(sendButton(page), 'the send control is enabled at 501 characters').toBeDisabled();
    await input.press('Enter');
    await page.waitForTimeout(500);
    expect(bodies.length, 'a 501-character message reached /api/ask').toBe(1);
  });
});

test.describe('suggested questions', () => {
  test('an empty conversation offers 4 to 6, and tapping one sends it', async ({ page }) => {
    const bodies = askRequests(page);
    await open(page);
    const offered = suggestions(page);
    const count = await offered.count();
    expect(count, 'the empty conversation shows 4 to 6 suggested questions').toBeGreaterThanOrEqual(4);
    expect(count).toBeLessThanOrEqual(6);

    const first = offered.first();
    const question = normalize(await first.innerText());
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/ask');
    await first.click();
    await answered;
    expect(bodies.map((b) => normalize(b.message ?? '')), 'tapping a suggestion did not send its text').toEqual([question]);
    await expect(conversation(page), 'the reply to the suggestion is not in the conversation').toContainText(fragments(fixedTextOf('not_in_source'))[0]);
  });
});

test.describe('pending reply', () => {
  test('shows a typing indicator and disables send, then shows the reply whole in one update', async ({ page }) => {
    await recordUpdates(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route('**/api/ask', async (route) => {
      await held;
      await route.continue();
    });
    await open(page);

    await messageInput(page).fill(TRIGGER.answered);
    await sendButton(page).click();
    await expect(typingIndicator(page).first(), 'no typing indicator while the reply is pending').toBeVisible();
    // Typed text cannot enable it either, if the input stays editable.
    if (await messageInput(page).isEnabled()) await messageInput(page).fill('And on Fridays?');
    await expect(sendButton(page), 'the send control is enabled while a reply is pending').toBeDisabled();

    release();
    await expect(conversation(page)).toContainText(ANSWERED_TEXT);
    await expect(typingIndicator(page), 'the typing indicator stayed after the reply').toHaveCount(0);

    const { all } = await updates(page);
    expect(all.some((u) => u.includes(ANSWERED_TEXT)), 'no single update added the whole reply').toBe(true);
    const partial = all.filter((u) => u.includes(`Marker ${MARKER}`) && !u.includes(ANSWERED_TEXT));
    expect(partial, 'the reply arrived in pieces').toEqual([]);
  });
});

test.describe('announcements', () => {
  test('a live region gets each reply whole, once', async ({ page }) => {
    await recordUpdates(page);
    await open(page);

    const handoffStart = (reason: 'not_in_source' | 'sensitive') => fragments(fixedTextOf(reason))[0];
    const expectation = /The front desk will see this today\.|Staff will see this after .{1,20}? on .{1,60}?\./;
    const replies = [
      { message: TRIGGER.answered, start: `Marker ${MARKER}`, whole: (t: string) => t.includes(ANSWERED_TEXT) },
      { message: 'Do you have a swimming pool?', start: handoffStart('not_in_source'), whole: (t: string) => t.includes(handoffStart('not_in_source')) && expectation.test(t) },
      { message: TRIGGER.sensitive, start: handoffStart('sensitive'), whole: (t: string) => t.includes(handoffStart('sensitive')) && expectation.test(t) },
    ];
    for (const r of replies) {
      await ask(page, r.message);
      await expect(conversation(page)).toContainText(r.start);
    }
    // Let any late announcement land before counting.
    await page.waitForTimeout(1000);

    const { live } = await updates(page);
    for (const r of replies) {
      const heard = live.filter((u) => u.includes(r.start));
      expect(heard.length, `"${r.start}" was announced ${heard.length} times, not once`).toBe(1);
      expect(r.whole(heard[0]), `the announcement of "${r.start}" is not the complete reply: "${heard[0]}"`).toBe(true);
    }
  });
});

test.describe('follow-up context', () => {
  test('carries the last 2 exchanges, and New conversation clears them', async ({ page }) => {
    const bodies = askRequests(page);
    await open(page);
    const messages = ['Do you have a swimming pool?', 'Do you have a garden?', 'Do you have a library?', 'What about on Fridays?'];
    for (const m of messages) await ask(page, m);

    expect(bodies.length).toBe(4);
    const last = bodies[3].priorTurns ?? [];
    expect(last.map((t) => t.role), 'the last message does not carry exactly the last 2 exchanges').toEqual(['parent', 'front_desk', 'parent', 'front_desk']);
    expect(last[0].text).toBe(messages[1]);
    expect(last[2].text).toBe(messages[2]);
    for (const t of [last[1], last[3]]) expect(normalize(t.text), 'a front desk turn is empty').not.toBe('');
    expect(JSON.stringify(last), 'an exchange older than the last 2 was sent').not.toContain(messages[0]);
    expect(bodies[0].priorTurns ?? [], 'the first message carried prior turns').toEqual([]);

    await newConversation(page).click();
    for (const m of messages) await expect(conversation(page), 'New conversation left a message on screen').not.toContainText(m);
    await expect(suggestions(page).first(), 'New conversation did not bring the suggested questions back').toBeVisible();

    await ask(page, 'Do you have a playground?');
    expect(bodies[4].priorTurns ?? [], 'the first message after New conversation carried prior turns').toEqual([]);
  });
});
