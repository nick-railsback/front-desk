// Failures in the operator view.
//
// failed save: when the database refuses the save, the view shows a fixed
// message, keeps its content, shows nothing internal, and the draft is
// unchanged.
//
// failed publish: when the database refuses the new snapshot, the view shows
// a fixed message, keeps its content, shows nothing internal, no snapshot is
// created, and the version shown stays the same.
//
// failed replay: when reading the replay's progress fails with a server
// error whose body holds a stack trace, SQL and the sandbox ID, the view
// shows a fixed message and none of that body.
//
// Nothing internal means no stack trace, error text, SQL, the failure's own
// text, an internal ID or the sandbox ID. The database being unavailable as
// the view loads is checked in ./own-server.spec.ts.
//
// Assumed interface: see ./support.ts.

import { expect, test } from '@playwright/test';
import {
  alertMessage,
  answerGap,
  bodyField,
  control,
  draftOf,
  editControls,
  expectClean,
  failWrites,
  itemTitled,
  letters,
  openOperator,
  publish,
  sandboxId,
  save,
  showArea,
  version,
  versionsOf,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 10_000 });

test.describe('failed save', () => {
  test('shows a fixed message and leaves the draft unchanged', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const info = await showArea(page, 'Center info');
    await editControls(itemTitled(info, 'Meals')).first().click();
    await bodyField(page).fill(`Oracle failing save ${letters(8)}.`);
    const before = await draftOf(id);
    const restore = await failWrites('drafts', id);
    try {
      const saved = await save(page);
      expect(saved.ok(), 'a save the database refused reported success').toBe(false);
      await expect(alertMessage(page).first(), 'a failed save shows no message').toBeVisible();
    } finally {
      await restore();
    }
    await expectClean(page, id, 'after a failed save');
    await expect(control(page.locator('body'), 'Questions').first(), 'the view lost its content after a failed save').toBeVisible();
    expect(await draftOf(id), 'a failed save changed the draft').toEqual(before);
  });
});

test.describe('failed publish', () => {
  test('shows a fixed message and creates no snapshot', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    const info = await showArea(page, 'Center info');
    await editControls(itemTitled(info, 'Absences')).first().click();
    await bodyField(page).fill(`Please tell us by 9:00 AM. Oracle ${letters(8)}.`);
    expect((await save(page)).ok(), 'the save failed').toBe(true);

    const restore = await failWrites('snapshots', id);
    try {
      const published = await publish(page);
      expect(published.ok(), 'a publish the database refused reported success').toBe(false);
      await expect(alertMessage(page).first(), 'a failed publish shows no message').toBeVisible();
    } finally {
      await restore();
    }
    await expectClean(page, id, 'after a failed publish');
    expect(await versionsOf(id), 'a failed publish created a snapshot').toEqual([1]);
    expect(await version(page), 'the version shown changed after a failed publish').toBe(1);
  });
});

test.describe('failed replay', () => {
  test('shows a fixed message and none of the failing response', async ({ page, context }) => {
    await openOperator(page);
    const id = await sandboxId(context);
    await page.route('**/api/replay*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `TypeError: oracle-boom at replay (/srv/app/replay.ts:12:5) select * from gaps where sandbox_id = '${id}'` }),
      }),
    );
    await answerGap(page, 'Summer program', `We run no summer program. Oracle ${letters(8)}.`);
    expect((await publish(page)).ok(), 'the publish failed').toBe(true);
    await expect(alertMessage(page).first(), 'a failed replay shows no message').toBeVisible({ timeout: 60_000 });
    await expectClean(page, id, 'after a failed replay');
    await expect(control(page.locator('body'), 'Gaps').first(), 'the view lost its content after a failed replay').toBeVisible();
  });
});
