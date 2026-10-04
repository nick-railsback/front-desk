// Failures of Reset demo and of dismissing the Try this strip.
//
// database refuses: when the database refuses every write naming the
// sandbox, as an unavailable database would, Reset demo and dismissing the
// strip each leave the view showing a fixed message; the view is not blank
// and shows no stack trace, error text, SQL, internal ID or sandbox ID.
//
// detail in the response: when the request answers with a server error
// whose body holds a stack trace, SQL and the sandbox ID, the view shows a
// fixed message and none of that body.
//
// A view that loads while the database is unavailable is checked by
// ../operator/own-server.spec.ts and ../../parent/server.test.ts.
//
// Assumed interface: see ./support.ts.

import { expect, test } from '@playwright/test';
import { failWritesFor } from '../../demo/tables';
import {
  BOOM,
  alertMessage,
  closeSql,
  confirmButton,
  cookieOf,
  dismiss,
  expectClean,
  failWritesWithDetail,
  openConfirmation,
  openView,
  strip,
  warmUp,
} from './support';

test.describe.configure({ timeout: 180_000 });
test.use({ actionTimeout: 15_000 });
test.afterAll(closeSql);
test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  await warmUp(browser);
});

test.describe('database refuses', () => {
  test('Reset demo on the operator view shows a fixed message and nothing internal', async ({ page, context }) => {
    await openView(page, '/operator');
    const id = await cookieOf(context);
    await openConfirmation(page);
    const restore = await failWritesFor(id, BOOM);
    try {
      await confirmButton(page).click();
      await expect(alertMessage(page).first(), 'a failed Reset demo shows no message').toBeVisible({ timeout: 30_000 });
      await expectClean(page, id, 'after a failed Reset demo');
    } finally {
      await restore();
    }
  });

  test('dismissing the strip on the parent view shows a fixed message and nothing internal', async ({ page, context }) => {
    await openView(page, '/');
    const id = await cookieOf(context);
    await expect(strip(page), 'no Try this strip to dismiss').toBeVisible();
    const restore = await failWritesFor(id, BOOM);
    try {
      await dismiss(page).click();
      await expect(alertMessage(page).first(), 'a failed dismissal shows no message').toBeVisible({ timeout: 30_000 });
      await expectClean(page, id, 'after a failed dismissal');
    } finally {
      await restore();
    }
  });
});

test.describe('detail in the response', () => {
  test('Reset demo on the parent view shows a fixed message and none of the response', async ({ page, context }) => {
    await openView(page, '/');
    const id = await cookieOf(context);
    await openConfirmation(page);
    const restore = await failWritesWithDetail(page, id);
    try {
      await confirmButton(page).click();
      await expect(alertMessage(page).first(), 'a failed Reset demo shows no message').toBeVisible({ timeout: 30_000 });
      await expectClean(page, id, 'after a failed Reset demo');
    } finally {
      await restore();
    }
  });

  test('dismissing the strip on the operator view shows a fixed message and none of the response', async ({ page, context }) => {
    await openView(page, '/operator');
    const id = await cookieOf(context);
    await expect(strip(page), 'no Try this strip to dismiss').toBeVisible();
    const restore = await failWritesWithDetail(page, id);
    try {
      await dismiss(page).click();
      await expect(alertMessage(page).first(), 'a failed dismissal shows no message').toBeVisible({ timeout: 30_000 });
      await expectClean(page, id, 'after a failed dismissal');
    } finally {
      await restore();
    }
  });
});
