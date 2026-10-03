// Shared helpers for the operator view browser tests. Not a test file:
// Playwright collects only *.spec.ts. The parent view's helpers and
// contracts in ../support.ts hold here too (the fd_sandbox cookie, the
// fixture model's `fixture:<reason> ` prefixes and its marker `pangolin`).
//
// Assumed interface. The tests hold the implementation to these contracts.
//
// 1. The fixture model answers a replayed or live message from the snapshot
//    (MODEL_MODE=fixture). A message with no `fixture:<reason> ` prefix
//    whose trimmed text appears word for word in the body of a
//    parent-visible section of the request's snapshot text is answered:
//      { outcome: 'answer', reason: 'answered', language: 'en',
//        text: a text carrying MARKER whose values all appear in that
//        section, for example `Marker pangolin: <message>`,
//        citations: [that section's ID], topic, gapLabel: null }
//    Every other unprefixed message gets today's not_in_source handoff.
//    Staff sections never reach the snapshot text, so they never answer.
//
// 2. Routes (see ../../operator/support.ts for their shapes):
//    POST /api/sections saves a section, POST /api/publish publishes and
//    starts the replay, GET /api/replay returns { running, completed, total }.
//    While a replay runs, the operator view polls GET /api/replay and shows
//    its progress from it as "<completed> of <total>". When a request to one
//    of them fails, the view shows a fixed message (see 6).
//
// 3. The operator view is the page at /operator. On a first visit it gives
//    the browser a sandbox and sets the fd_sandbox cookie, as / does.
//    - The role switcher holds controls named "Parent" and "Operator"; on
//      /operator, Operator is marked current (aria-current, aria-selected
//      or aria-pressed) and Parent is not.
//    - The summary strip is a region whose accessible name contains
//      "Summary" or "Last 7 days". Each statistic is one list item in it,
//      holding its number and its label: "asked" (questions asked),
//      "answered" (a whole percent, "67%"), "handoff" (handoffs), "urgent"
//      (urgent replies), "open gap" (open gaps). Labels match
//      case-insensitively; the questions-asked label does not contain
//      "answered".
//    - The current snapshot version reads "Version <n>" (case-insensitive).
//    - Three areas, each opened by a control (tab, link or button) named
//      exactly "Questions", "Gaps" and "Center info", and shown as a
//      tabpanel or region with that same accessible name.
//
// 4. Questions: each question is a list item (li) in the Questions area
//    holding its message, how long ago it was asked ("2 hours ago",
//    "3 days ago", "30 minutes ago"; "hr", "min" or "h"/"d" forms are
//    accepted), its outcome and reason (underscores may show as spaces),
//    and the titles of the sections it cites; a reply sent to the front desk
//    also shows "Sent to front desk". The first button or link in the item
//    opens it. The outcome filter is a select (combobox) or a set of
//    buttons, radios or tabs, labeled with "outcome" or holding options
//    named "All", "Answer", "Handoff", "Urgent" (plural forms accepted).
//    An opened question shows its reply in a dialog, or in a region whose
//    accessible name starts with "Reply"; its citation chips are buttons
//    with aria-expanded, named with the section's title as it was in the
//    reply's snapshot version, and an expanded chip shows that section's
//    text.
//
// 5. Gaps: each gap is a list item (li) in the Gaps area holding its label
//    (as an element whose own text is exactly the label),
//    "<n> questions", how long ago its newest question was asked, and its 3
//    most recent phrasings. An open gap's item holds a button or link named
//    "Answer this"; a resolved gap's item holds none and shows "Resolved".
//    After a replay each replayed gap's item shows "<N> of <M> now answered".
//
// 6. Center info: each section is a list item (li) in the Center info area
//    holding its title (as an element whose own text is exactly the title),
//    its visibility ("parent" or "staff") and, for a policy section, its
//    last-updated date in the form "November 26, 2026". Each policy item has
//    a button or link whose name contains "Edit"; the area has one whose name
//    contains "Add". Data sections (Hours, Calendar, Menu, Alerts, Tuition,
//    Contacts) show "From center records" and have no edit control.
//    The editor has text fields labeled "Title" and "Body", a visibility
//    control labeled "Visibility" (a select whose values are `parent` and
//    `staff`, or radios named "Parent" and "Staff"), and buttons named
//    "Save" and "Publish" (Publish may sit outside the editor). "Unpublished
//    changes" shows while the draft differs from the latest snapshot.
//    A refused save, a failed save, publish or replay, and a database that
//    is unavailable as the view loads each show a message in an element
//    with role `alert`.

import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { db, normalize, sandboxId } from '../support';

export { COOKIE, MARKER, TRIGGER, ask, db, normalize, open as openParent, recordUpdates, sandboxId, unique, updates } from '../support';

export const AREAS = ['Questions', 'Gaps', 'Center info'] as const;
export type AreaName = (typeof AREAS)[number];
export const DATA_SECTIONS = ['Hours', 'Calendar', 'Menu', 'Alerts', 'Tuition', 'Contacts'] as const;

// The seeded open gaps' questions, newest first within each gap.
export const SEEDED_GAPS: Record<string, string[]> = {
  'Sibling discount': [
    'Do you offer a discount for siblings?',
    'Is there a sibling discount if both my kids enroll?',
    'My twins start next month. Is there a family rate?',
    'Does the second child get reduced tuition?',
    'Do brothers and sisters get a price break on tuition?',
    'We have a toddler and a preschooler. Any discount for having two kids there?',
    'Is tuition cheaper for the second kid in the same family?',
  ],
  'Part-time schedules': [
    'Can my daughter come just Tuesdays and Thursdays?',
    'Do you have a part-time option?',
    'Is there a 3 day a week schedule for preschool?',
    'Can I pay for half days only?',
    'Do you prorate tuition if he only comes Mondays, Wednesdays, and Fridays?',
  ],
  'Summer program': [
    'Is there a summer program for kids who finish Pre-K?',
    'What does the summer schedule look like?',
    'Do you run a summer camp?',
    'Are you open in the summer for school-age kids?',
  ],
};

export const STACK = /\bat\s+\S+\s+\(?[^\s()]+:\d+:\d+\)?|\b(?:Type|Reference|Syntax|Range)?Error\b|ECONNREFUSED|ECONNRESET|node_modules|\.tsx?:\d+/;
export const SQL = /\binsert\s+into\b|\bupdate\s+"?\w+"?\s+set\b|\bselect\b[\s\S]{0,200}\bfrom\b|\bdelete\s+from\b|\bviolates\b|\brelation\s+"/i;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

// ---------------------------------------------------------------------------
// The operator view.

export function control(scope: Page | Locator, name: string | RegExp): Locator {
  return scope.getByRole('tab', { name, exact: true }).or(scope.getByRole('link', { name, exact: true })).or(scope.getByRole('button', { name, exact: true }));
}

export function area(page: Page, name: AreaName): Locator {
  return page.getByRole('tabpanel', { name, exact: true }).or(page.getByRole('region', { name, exact: true })).first();
}

export async function showArea(page: Page, name: AreaName): Promise<Locator> {
  const c = control(page.locator('body'), name).first();
  await expect(c, `no control opens the ${name} area`).toBeVisible();
  await c.click();
  const a = area(page, name);
  await expect(a, `the ${name} area is not shown`).toBeVisible();
  return a;
}

export async function openOperator(page: Page, path = '/operator'): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), 'the operator view did not load').toBe(200);
  await expect(control(page.locator('body'), 'Questions').first(), 'the operator view shows no Questions control').toBeVisible();
}

export function summary(page: Page): Locator {
  return page.getByRole('region', { name: /summary|last 7 days/i }).first();
}

export type Stats = { asked: string; answered: string; handoffs: string; urgent: string; openGaps: string };

export async function stats(page: Page): Promise<Stats> {
  const strip = summary(page);
  await expect(strip, 'no summary strip').toBeVisible();
  const items = (await strip.getByRole('listitem').allInnerTexts()).map(normalize);
  const pick = (what: string, label: RegExp, exclude?: RegExp): string => {
    const found = items.filter((t) => label.test(t) && !(exclude && exclude.test(t)));
    expect(found.length, `the summary strip has no single statistic for ${what} (items: ${JSON.stringify(items)})`).toBe(1);
    const n = /\d+%?/.exec(found[0]);
    expect(n, `the ${what} statistic shows no number: "${found[0]}"`).toBeTruthy();
    return n![0];
  };
  return {
    asked: pick('questions asked', /asked/i),
    answered: pick('percent answered', /answered/i, /asked/i),
    handoffs: pick('handoffs', /hand-?offs?/i),
    urgent: pick('urgent replies', /urgent/i),
    openGaps: pick('open gaps', /open gaps?/i),
  };
}

export async function version(page: Page): Promise<number> {
  const el = page.getByText(/\bversion\s*\d+\b/i).first();
  await expect(el, 'the snapshot version is not shown').toBeVisible();
  return Number(/\bversion\s*(\d+)\b/i.exec(await el.innerText())![1]);
}

export function itemWith(scope: Locator, text: string): Locator {
  return scope.locator('li').filter({ hasText: text }).last();
}

// A gap's item: the innermost li holding an element whose own text is exactly
// the label (a phrasing may contain the label's words).
export function gapItem(gaps: Locator, label: string): Locator {
  return gaps.locator('li').filter({ has: gaps.page().getByText(label, { exact: true }) }).last();
}

export function itemTitled(scope: Locator, title: string): Locator {
  return scope.locator('li').filter({ has: scope.page().getByText(title, { exact: true }) }).last();
}

export function opener(item: Locator): Locator {
  return item.locator('button, a[href], [role=button], [role=link]').first();
}

export function openedQuestion(page: Page): Locator {
  return page.getByRole('dialog').or(page.getByRole('region', { name: /^reply\b/i })).filter({ visible: true }).first();
}

export function chips(scope: Locator): Locator {
  return scope.locator('button[aria-expanded]');
}

export function answerThis(scope: Locator): Locator {
  return scope.getByRole('button', { name: /answer this/i }).or(scope.getByRole('link', { name: /answer this/i }));
}

export function editControls(scope: Locator): Locator {
  return scope.getByRole('button', { name: /edit/i }).or(scope.getByRole('link', { name: /edit/i }));
}

export function titleField(page: Page): Locator {
  return page.getByRole('textbox', { name: /^title\b/i });
}

export function bodyField(page: Page): Locator {
  return page.getByRole('textbox', { name: /^body\b/i });
}

export function saveButton(page: Page): Locator {
  return page.getByRole('button', { name: /^save\b/i });
}

export function publishButton(page: Page): Locator {
  return page.getByRole('button', { name: /^publish\b/i });
}

export function alertMessage(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: /[A-Za-z]{3}/ }).filter({ visible: true });
}

export async function visibilityOf(page: Page): Promise<string> {
  const select = page.getByRole('combobox', { name: /visibility/i });
  if ((await select.count()) > 0) return select.first().inputValue();
  for (const v of ['parent', 'staff']) {
    if (await page.getByRole('radio', { name: new RegExp(`^${v}\\b`, 'i') }).first().isChecked().catch(() => false)) return v;
  }
  return '';
}

export async function setVisibility(page: Page, value: 'parent' | 'staff'): Promise<void> {
  const select = page.getByRole('combobox', { name: /visibility/i });
  if ((await select.count()) > 0) {
    await select.first().selectOption(value);
    return;
  }
  await page.getByRole('radio', { name: new RegExp(`^${value}\\b`, 'i') }).first().check();
}

export function sectionsResponse(page: Page): Promise<Response> {
  return page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sections' && r.request().method() === 'POST');
}

export async function save(page: Page): Promise<Response> {
  const saved = sectionsResponse(page);
  await saveButton(page).click();
  return saved;
}

// Publish may live in any area; it is looked for in Center info when the
// current area does not show it.
export async function publish(page: Page): Promise<Response> {
  if (!(await publishButton(page).first().isVisible())) await showArea(page, 'Center info');
  const published = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/publish' && r.request().method() === 'POST');
  await publishButton(page).first().click();
  return published;
}

// Opens "Answer this" on a gap, fills the body, saves, and waits for the
// save to succeed.
export async function answerGap(page: Page, label: string, body: string): Promise<void> {
  const gaps = await showArea(page, 'Gaps');
  const item = gapItem(gaps, label);
  await answerThis(item).first().click();
  await expect(titleField(page), 'Answer this opened no editor').toBeVisible();
  await bodyField(page).fill(body);
  const saved = await save(page);
  expect(saved.ok(), `the save failed with ${saved.status()}`).toBe(true);
}

// Waits until every gap in `expected` shows "<N> of <M> now answered".
export async function expectResults(page: Page, expected: Record<string, string>, timeout: number): Promise<void> {
  const gaps = await showArea(page, 'Gaps');
  for (const [label, result] of Object.entries(expected)) {
    await expect(gapItem(gaps, label), `the ${label} gap does not show "${result} now answered"`).toContainText(new RegExp(`\\b${result}\\s+now answered`, 'i'), { timeout });
  }
}

// The whole view's text plus the values of its fields.
export async function everything(page: Page): Promise<string> {
  return page.evaluate(() => {
    const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value);
    return [document.body.innerText, ...values].join('\n');
  });
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export function agoPattern(n: number, unit: 'minute' | 'hour' | 'day'): RegExp {
  const short = { minute: 'm(?:in)?s?', hour: 'h(?:rs?)?', day: 'd(?:ays?)?' }[unit];
  return new RegExp(`\\b${n}\\s*(?:${unit}s?|${short})\\.?\\s+ago\\b`, 'i');
}

// ---------------------------------------------------------------------------
// The database.

export type TurnSpec = {
  message: string;
  agoMs: number;
  outcome: 'answer' | 'handoff' | 'urgent';
  reason: string;
  cites?: string[];
  source?: 'seed' | 'live';
  sent?: boolean;
  text?: string;
};

// Replaces the sandbox's questions and gaps with `turns` and `gaps`.
export async function setHistory(
  id: string,
  turns: TurnSpec[],
  gaps: { label: string; messages: string[]; status?: string }[] = [],
): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('begin');
    await client.query('delete from gaps where sandbox_id = $1', [id]);
    await client.query('delete from turns where sandbox_id = $1', [id]);
    const ids = new Map<string, string>();
    for (const [i, t] of turns.entries()) {
      const turnId = `oracle-${i}-${letters(8)}`;
      ids.set(t.message, turnId);
      await client.query(
        `insert into turns (sandbox_id, id, message, created_at, answer_text, outcome, reason, snapshot_version, citations, source, sent_to_front_desk)
         values ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10)`,
        [
          id,
          turnId,
          t.message,
          new Date(Date.now() - t.agoMs),
          t.text ?? `Oracle reply to ${t.message}`,
          t.outcome,
          t.reason,
          JSON.stringify((t.cites ?? []).map((sectionId) => ({ sectionId }))),
          t.source ?? 'live',
          t.sent ? new Date(Date.now() - t.agoMs + 1000) : null,
        ],
      );
    }
    for (const [i, g] of gaps.entries()) {
      const gapId = `oracle-gap-${i}-${letters(8)}`;
      await client.query('insert into gaps (sandbox_id, id, label, status) values ($1, $2, $3, $4)', [id, gapId, g.label, g.status ?? 'open']);
      for (const m of g.messages) {
        await client.query('insert into gap_members (sandbox_id, gap_id, turn_id) values ($1, $2, $3)', [id, gapId, ids.get(m)]);
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export type DbSection = { id: string; title: string; visibility: string; updatedOn: string; text: string };

export async function draftOf(id: string): Promise<DbSection[]> {
  const { rows } = await db().query('select sections from drafts where sandbox_id = $1', [id]);
  expect(rows.length, `sandbox ${id} holds no draft`).toBe(1);
  return rows[0].sections as DbSection[];
}

export async function versionsOf(id: string): Promise<number[]> {
  const { rows } = await db().query('select version from snapshots where sandbox_id = $1 order by version', [id]);
  return rows.map((r) => Number(r.version));
}

// A trigger that makes every write to `table` for one sandbox fail.
export async function failWrites(table: 'drafts' | 'snapshots', id: string): Promise<() => Promise<void>> {
  const name = `oracle_fail_${letters(16)}`;
  await db().query(`
    create function ${name}() returns trigger language plpgsql as $$
    begin
      if (tg_op = 'DELETE' and old.sandbox_id = '${id}') or (tg_op <> 'DELETE' and new.sandbox_id = '${id}') then
        raise exception 'oracle-boom % on ${table} for ${id}', tg_op;
      end if;
      return coalesce(new, old);
    end $$`);
  await db().query(`create trigger ${name} before insert or update or delete on ${table} for each row execute function ${name}()`);
  return async () => {
    await db().query(`drop trigger if exists ${name} on ${table}`);
    await db().query(`drop function if exists ${name}()`);
  };
}

export async function expectClean(page: Page, id: string, what: string): Promise<void> {
  const text = await page.locator('body').innerText();
  expect(normalize(text).length, `${what}: the page is blank`).toBeGreaterThan(0);
  expect(text, `${what}: the page shows a stack trace or error`).not.toMatch(STACK);
  expect(text, `${what}: the page shows SQL or a database error`).not.toMatch(SQL);
  expect(text, `${what}: the page shows the failure's own text`).not.toContain('oracle-boom');
  expect(text, `${what}: the page shows an internal ID`).not.toMatch(UUID);
  expect(text, `${what}: the page shows the sandbox ID`).not.toContain(id);
}

export { sandboxId as cookieSandbox };
