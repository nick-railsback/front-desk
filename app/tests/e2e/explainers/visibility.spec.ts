// What the operator view says about a section's visibility.
//
// visibility labels: in the section editor, opened from Add section, from a
// section's Edit or from a gap's Answer this, the two visibility radios are
// named exactly "Parent (the front desk answers from it)" and "Staff only
// (never shown to parents)".
//
// center info lines: each policy section's item in Center info shows
// "Parent" for a parent-visible section and "Staff only" for a staff
// section; the seeded Lockdown procedure shows "Staff only".
//
// gap note: in the editor opened from a gap, choosing Staff only shows a
// status note that the gap stays open because parents never see staff-only
// text; choosing Parent again hides it. Opened from Add section or from a
// section's Edit, Staff only shows no such note.
//
// Assumed interface: see ./support.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  PARENT_LABEL,
  STAFF_LABEL,
  answerThis,
  cancelButton,
  cookieOf,
  draftOf,
  editControls,
  gapItem,
  gapNote,
  itemTitled,
  normalize,
  openView,
  parentRadio,
  showArea,
  staffRadio,
  titleField,
  warmUp,
} from './support';

test.describe.configure({ timeout: 120_000 });
test.use({ actionTimeout: 10_000 });
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

const GAP = 'Sibling discount';

async function openFromGap(page: Page): Promise<void> {
  await answerThis(gapItem(await showArea(page, 'Gaps'), GAP)).first().click();
  await expect(titleField(page), 'Answer this opened no editor').toBeVisible();
}

async function openFromAdd(page: Page): Promise<void> {
  const info = await showArea(page, 'Center info');
  await info.getByRole('button', { name: /add/i }).or(info.getByRole('link', { name: /add/i })).first().click();
  await expect(titleField(page), 'Add section opened no editor').toBeVisible();
}

async function openFromEdit(page: Page, title: string): Promise<void> {
  await editControls(itemTitled(await showArea(page, 'Center info'), title)).first().click();
  await expect(titleField(page), `Edit on ${title} opened no editor`).toBeVisible();
}

async function expectLabels(page: Page, what: string): Promise<void> {
  // visibility labels: exact accessible names.
  await expect(parentRadio(page), `${what}: no radio named exactly "${PARENT_LABEL}"`).toBeVisible();
  await expect(staffRadio(page), `${what}: no radio named exactly "${STAFF_LABEL}"`).toBeVisible();
}

async function chooseStaffAndExpectNoNote(page: Page, what: string): Promise<void> {
  await expect(staffRadio(page), `${what}: no radio named exactly "${STAFF_LABEL}"`).toBeVisible();
  await staffRadio(page).check();
  await expect(staffRadio(page)).toBeChecked();
  // gap note: none outside the editor opened from a gap. Wait long enough
  // for a note to render if one were coming.
  await page.waitForTimeout(500);
  await expect(gapNote(page), `${what}: Staff only shows the gap note`).toHaveCount(0);
}

test.describe('visibility labels', () => {
  test('the editor names its visibility radios for who sees each, opened from Add section, Edit and Answer this', async ({ page }) => {
    await openView(page, '/operator');
    await openFromAdd(page);
    await expectLabels(page, 'opened from Add section');
    await cancelButton(page).click();

    await openFromEdit(page, 'Meals');
    await expectLabels(page, 'opened from Edit on Meals');
    await expect(parentRadio(page), 'Meals is not shown as Parent').toBeChecked();
    await cancelButton(page).click();

    await openFromEdit(page, 'Lockdown procedure');
    await expectLabels(page, 'opened from Edit on Lockdown procedure');
    await expect(staffRadio(page), 'Lockdown procedure is not shown as Staff only').toBeChecked();
    await cancelButton(page).click();

    await openFromGap(page);
    await expectLabels(page, 'opened from Answer this');
    await expect(parentRadio(page), 'a section opened from a gap does not start as Parent').toBeChecked();
  });
});

test.describe('center info lines', () => {
  test('each policy section shows Parent or Staff only, and Lockdown procedure shows Staff only', async ({ page, context }) => {
    await openView(page, '/operator');
    const sections = await draftOf(await cookieOf(context));
    const info = await showArea(page, 'Center info');

    // center info lines: the seeded staff-only section. The item's text runs
    // its title straight into its line ("Lockdown procedureStaff only"), so
    // "Staff only" is matched with no word boundary before it.
    const lockdown = itemTitled(info, 'Lockdown procedure');
    await expect(lockdown, 'Center info lists no Lockdown procedure').toBeVisible();
    await expect(lockdown, 'Lockdown procedure does not show "Staff only"').toContainText(/Staff only\b/);

    // center info lines: every policy section, against its stored visibility.
    let policies = 0;
    for (const s of sections) {
      const item = itemTitled(info, s.title);
      if ((await item.count()) === 0 || (await editControls(item).count()) === 0) continue;
      policies++;
      const line = normalize(await item.innerText());
      if (s.visibility === 'staff') {
        expect(line, `${s.title} is staff only but its line ("${line}") does not show "Staff only"`).toMatch(/\bStaff only\b/);
      } else {
        expect(line, `${s.title} is parent-visible but its line ("${line}") does not show "Parent"`).toMatch(/\bParent\b/);
        expect(line, `${s.title} is parent-visible but its line ("${line}") shows "Staff only"`).not.toMatch(/\bstaff only\b/i);
      }
    }
    expect(policies, 'Center info shows no policy section with an Edit control').toBeGreaterThan(1);
  });
});

test.describe('gap note', () => {
  test('opened from a gap, Staff only shows a status note that the gap stays open, and Parent hides it', async ({ page }) => {
    await openView(page, '/operator');
    await openFromGap(page);
    await expect(gapNote(page), 'the gap note shows while Parent is chosen').toHaveCount(0);

    // gap note: shown in a status element while Staff only is chosen.
    await expect(staffRadio(page), `no radio named exactly "${STAFF_LABEL}"`).toBeVisible();
    await staffRadio(page).check();
    await expect(gapNote(page).first(), 'choosing Staff only for a section opened from a gap shows no status note that the gap stays open').toBeVisible();
    const note = normalize(await gapNote(page).first().innerText());
    expect(note, `the gap note ("${note}") does not say parents never see the section`).toMatch(/\bparents?\b/i);

    // gap note: hidden again once Parent is chosen.
    await parentRadio(page).check();
    await expect(gapNote(page), 'choosing Parent again leaves the gap note shown').toHaveCount(0);

    // gap note: and back again with Staff only.
    await staffRadio(page).check();
    await expect(gapNote(page).first(), 'choosing Staff only a second time shows no gap note').toBeVisible();
  });

  test('opened from Add section or from Edit, Staff only shows no gap note', async ({ page }) => {
    await openView(page, '/operator');

    await openFromAdd(page);
    await chooseStaffAndExpectNoNote(page, 'opened from Add section');
    await cancelButton(page).click();

    await openFromEdit(page, 'Meals');
    await chooseStaffAndExpectNoNote(page, 'opened from Edit on Meals');
    await cancelButton(page).click();

    // gap note: an editor once opened from a gap, then closed, leaves no
    // trace in the next one opened from Add section.
    await openFromGap(page);
    await cancelButton(page).click();
    await openFromAdd(page);
    await chooseStaffAndExpectNoNote(page, 'opened from Add section after an editor opened from a gap was cancelled');
  });
});
