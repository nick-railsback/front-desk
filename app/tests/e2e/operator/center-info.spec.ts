// Center info, editing and publishing.
//
// section list: every policy section in the draft is listed with its title,
// its visibility (the Lockdown procedure as staff) and its last-updated
// date, with an edit control on each, and the area has an add control. The
// six data sections are listed read-only, each labeled "From center
// records", with no edit control.
//
// refused save: a save the server refuses (a title over 80 characters, with
// the field's own length limit removed) shows an inline message and leaves
// the draft unchanged.
//
// unpublished changes: "Unpublished changes" is not shown on a new sandbox,
// is shown after a save that changes a section, and is gone after
// publishing. Publishing moves the version shown from N to N+1 and keeps
// version N.
//
// Assumed interface: see ./support.ts.

import { expect, test } from '@playwright/test';
import {
  DATA_SECTIONS,
  alertMessage,
  bodyField,
  draftOf,
  editControls,
  itemTitled,
  letters,
  normalize,
  openOperator,
  publish,
  sandboxId,
  save,
  saveButton,
  showArea,
  titleField,
  version,
  versionsOf,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });

const LONG_DATE = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function longDate(date: string): string {
  return LONG_DATE.format(new Date(`${date}T12:00:00Z`));
}

test.describe('section list', () => {
  test('lists every draft policy section with visibility, date and an edit control, and the data sections read-only', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const info = await showArea(page, 'Center info');
    const draft = await draftOf(id);
    expect(draft.some((s) => s.id === 'lockdown-procedure' && s.visibility === 'staff'), 'the seeded draft has no staff Lockdown procedure').toBe(true);

    for (const s of draft) {
      const item = itemTitled(info, s.title);
      await expect(item, `the ${s.title} section is not listed`).toBeVisible();
      const text = normalize(await item.innerText());
      expect(text, `${s.title}: its visibility is not shown`).toMatch(new RegExp(`\\b${s.visibility}\\b`, 'i'));
      expect(text, `${s.title}: its last-updated date is not shown as ${longDate(s.updatedOn)}`).toContain(longDate(s.updatedOn));
      await expect(editControls(item), `${s.title}: no edit control`).not.toHaveCount(0);
    }
    await expect(info.getByRole('button', { name: /add/i }).or(info.getByRole('link', { name: /add/i })), 'Center info has no add control').not.toHaveCount(0);

    for (const title of DATA_SECTIONS) {
      const item = itemTitled(info, title);
      await expect(item, `the ${title} data section is not listed`).toBeVisible();
      await expect(item, `${title}: not labeled From center records`).toContainText(/from center records/i);
      await expect(editControls(item), `${title}: a data section has an edit control`).toHaveCount(0);
    }
  });
});

test.describe('refused save', () => {
  test('a title over 80 characters shows an inline message and leaves the draft unchanged', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const info = await showArea(page, 'Center info');
    await editControls(itemTitled(info, 'Meals')).first().click();
    await expect(titleField(page), 'the edit control opened no editor').toBeVisible();
    const before = await draftOf(id);

    await titleField(page).evaluate((el) => el.removeAttribute('maxlength'));
    await titleField(page).fill(`T${letters(80)}`);
    await saveButton(page).click();
    await expect(alertMessage(page).first(), 'a refused save shows no inline message').toBeVisible();
    await expect(titleField(page), 'the editor closed after a refused save').toBeVisible();
    expect(await draftOf(id), 'a refused save changed the draft').toEqual(before);
  });
});

test.describe('unpublished changes', () => {
  test('shows only while the draft differs from the latest snapshot, and publishing moves the version to N+1', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const indicator = page.getByText(/unpublished changes/i).filter({ visible: true });
    expect(await version(page)).toBe(1);
    await expect(indicator, 'a new sandbox shows Unpublished changes').toHaveCount(0);

    const info = await showArea(page, 'Center info');
    await editControls(itemTitled(info, 'Absences')).first().click();
    await bodyField(page).fill(`Please tell us by 9:00 AM. Oracle ${letters(8)}.`);
    expect((await save(page)).ok(), 'the save failed').toBe(true);
    await expect(indicator.first(), 'a changed draft shows no Unpublished changes').toBeVisible();
    await page.reload();
    await expect(indicator.first(), 'Unpublished changes is gone after a reload').toBeVisible();

    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expect.poll(() => version(page), { message: 'the version shown did not become 2' }).toBe(2);
    await expect(indicator, 'Unpublished changes is still shown after publishing').toHaveCount(0);
    expect(await versionsOf(id), 'publishing did not keep version 1 and add version 2').toEqual([1, 2]);
    await page.reload();
    expect(await version(page)).toBe(2);
    await expect(indicator).toHaveCount(0);
  });
});
