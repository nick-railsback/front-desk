// Saving and publishing, seen from the routes, the model input and the
// database.
//
// save validation: a section with a title of exactly 80 characters and a
// text of exactly 4,000 characters saves, as written. A title of 81
// characters, a text of 4,001 characters, or a visibility other than
// `parent` or `staff` is refused with a 4xx status, and the draft is exactly
// what it was before the refused save.
//
// no model call: saving a section and publishing with no open gap make no
// model call.
//
// draft isolation: a saved section changes no parent reply until it is
// published. A parent message sent after the save and before any publish is
// answered from the latest snapshot's version, and nothing the operator
// saved (a new section's title and text, an edited section's text) reaches
// the model input.
//
// publish: publishing creates snapshot version N+1 holding the draft's
// sections, and version N stays exactly as it was. A parent message after
// the publish records version N+1; its model input holds a published
// parent section's text and never a staff section's text. A section added
// or edited in the publish carries today's date in America/Denver; every
// other section keeps its date.
//
// failures: a save the database refuses leaves the draft unchanged; a
// publish the database refuses creates no snapshot. Neither response holds a
// stack trace, SQL, the database's error text, or the sandbox ID.
//
// Assumed interface: see ./support.ts.

import { afterAll, afterEach, describe, expect, test } from 'vitest';
import {
  answeringModel,
  askAs,
  closeSql,
  draftOf,
  expectNoLeak,
  failWrites,
  inputOf,
  letters,
  loadRoutes,
  publishDraft,
  replayFinished,
  saveSection,
  snapshotsOf,
  sql,
  today,
  unload,
} from './support';

const MINUTES = 60_000;

afterEach(unload);
afterAll(closeSql);

describe('save validation', () => {
  test(
    'an 80-character title and a 4,000-character text save; 81, 4,001 and an unknown visibility are refused and change nothing',
    async () => {
      const r = await loadRoutes(answeringModel().model);
      const id = await r.db.createSandbox(new Date());

      const title80 = `T${letters(79)}`;
      const text4000 = `B${letters(3999)}`;
      expect(title80.length).toBe(80);
      expect(text4000.length).toBe(4000);
      const saved = await saveSection(r, id, { id: null, title: title80, visibility: 'parent', text: text4000 });
      expect(saved.status, `the boundary save was refused: ${saved.text.slice(0, 200)}`).toBeGreaterThanOrEqual(200);
      expect(saved.status).toBeLessThan(300);
      const after = await draftOf(id);
      const added = after.filter((s) => s.title === title80);
      expect(added.length, 'the draft does not hold the 80-character section once').toBe(1);
      expect(added[0].text, 'the draft does not hold the 4,000-character text as written').toBe(text4000);
      expect(added[0].visibility).toBe('parent');

      const meals = after.find((s) => s.id === 'meals');
      expect(meals, 'the draft has no meals section').toBeTruthy();
      const refused = [
        { what: 'a new section with an 81-character title', body: { id: null, title: `T${letters(80)}`, visibility: 'parent', text: 'Oracle text.' } },
        { what: 'a new section with a 4,001-character text', body: { id: null, title: 'Oracle title', visibility: 'parent', text: `B${letters(4000)}` } },
        { what: "a new section with visibility 'public'", body: { id: null, title: 'Oracle title', visibility: 'public', text: 'Oracle text.' } },
        { what: 'an edit with an 81-character title', body: { id: 'meals', title: `T${letters(80)}`, visibility: 'parent', text: meals!.text } },
        { what: 'an edit with a 4,001-character text', body: { id: 'meals', title: meals!.title, visibility: 'parent', text: `B${letters(4000)}` } },
        { what: "an edit with visibility 'everyone'", body: { id: 'meals', title: meals!.title, visibility: 'everyone', text: meals!.text } },
      ];
      for (const { what, body } of refused) {
        const before = await draftOf(id);
        const res = await saveSection(r, id, body);
        expect(res.status, `${what} was not refused with a 4xx status`).toBeGreaterThanOrEqual(400);
        expect(res.status, `${what} was not refused with a 4xx status`).toBeLessThan(500);
        expect(await draftOf(id), `${what} changed the draft`).toEqual(before);
        expectNoLeak(res.text, id, what);
      }
    },
    2 * MINUTES,
  );
});

describe('no model call', () => {
  test(
    'saving a section and publishing with no open gap make no model call',
    async () => {
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      await sql().query('delete from gaps where sandbox_id = $1', [id]);

      const saved = await saveSection(r, id, { id: null, title: 'Oracle quiet hours', visibility: 'parent', text: `Quiet hours ${letters(8)}.` });
      expect(saved.status, `the save failed: ${saved.text.slice(0, 200)}`).toBeLessThan(300);
      expect(recorded.requests.length, 'saving a section called the model').toBe(0);

      const published = await publishDraft(r, id);
      expect(published.status, `the publish failed: ${published.text.slice(0, 200)}`).toBeLessThan(300);
      await replayFinished(r, id, 2 * MINUTES);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(recorded.requests.length, 'publishing with no open gap called the model').toBe(0);

      // The recording model is the one the app calls.
      await askAs(r, id, 'Do you have a swimming pool?');
      expect(recorded.requests.length, 'a parent message reached no model, so this check proves nothing').toBeGreaterThan(0);
    },
    4 * MINUTES,
  );
});

describe('draft isolation', () => {
  test(
    'a saved section reaches no parent reply until it is published',
    async () => {
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      const newTitle = `Oracle title ${letters(12)}`;
      const newText = `Oracle body ${letters(12)} for families.`;
      const editText = `Oracle edit ${letters(12)} about meals.`;
      const meals = (await draftOf(id)).find((s) => s.id === 'meals')!;

      expect((await saveSection(r, id, { id: null, title: newTitle, visibility: 'parent', text: newText })).status).toBeLessThan(300);
      expect((await saveSection(r, id, { id: 'meals', title: meals.title, visibility: 'parent', text: editText })).status).toBeLessThan(300);
      const draft = await draftOf(id);
      expect(draft.some((s) => s.title === newTitle && s.text === newText), 'the new section is not in the draft').toBe(true);
      expect(draft.find((s) => s.id === 'meals')?.text, 'the edit is not in the draft').toBe(editText);

      const message = `Do you have a swimming pool? Ref ${letters(10)}.`;
      const asked = await askAs(r, id, message);
      expect(asked.status).toBe(200);
      const request = recorded.requests.find((q) => q.message.includes(message));
      expect(request, 'the parent message reached no model').toBeTruthy();
      const input = inputOf(request!);
      for (const saved of [newTitle, newText, editText]) {
        expect(input, `the model input holds saved, unpublished text "${saved}"`).not.toContain(saved);
      }
      const { rows } = await sql().query('select snapshot_version from turns where sandbox_id = $1 and message = $2', [id, message]);
      expect(rows.map((t) => t.snapshot_version), 'the reply does not record the latest published version').toEqual([1]);
    },
    2 * MINUTES,
  );
});

describe('publish', () => {
  test(
    "creates version N+1 from the draft, keeps N, and later messages use N+1's parent sections only",
    async () => {
      const recorded = answeringModel();
      const r = await loadRoutes(recorded.model);
      const id = await r.db.createSandbox(new Date());
      const [v1] = await snapshotsOf(id);
      expect(v1.version).toBe(1);
      const dayBefore = today();

      const parentText = `Oracle parent body ${letters(12)}.`;
      const staffText = `Oracle staff body ${letters(12)}.`;
      const editText = `Oracle edited illness body ${letters(12)}.`;
      const illness = v1.sections.find((s) => s.id === 'illness')!;
      for (const section of [
        { id: null, title: `Oracle parent ${letters(6)}`, visibility: 'parent', text: parentText },
        { id: null, title: `Oracle staff ${letters(6)}`, visibility: 'staff', text: staffText },
        { id: 'illness', title: illness.title, visibility: 'parent', text: editText },
      ]) {
        const saved = await saveSection(r, id, section);
        expect(saved.status, `a save failed: ${saved.text.slice(0, 200)}`).toBeLessThan(300);
      }

      const published = await publishDraft(r, id);
      expect(published.status, `the publish failed: ${published.text.slice(0, 200)}`).toBeLessThan(300);
      const dayAfter = today();
      const snapshots = await snapshotsOf(id);
      expect(snapshots.map((s) => s.version), 'publishing did not add exactly version 2').toEqual([1, 2]);
      expect(snapshots[0], 'publishing changed version 1').toEqual(v1);
      const v2 = snapshots[1];
      const undated = (sections: { updatedOn?: string }[]) => sections.map(({ updatedOn: _d, ...rest }) => rest);
      expect(undated(v2.sections), "version 2 does not hold the draft's sections").toEqual(undated(await draftOf(id)));

      const changed = new Set(['illness']);
      const byText = (t: string) => v2.sections.find((s) => s.text === t);
      for (const t of [parentText, staffText]) {
        const s = byText(t);
        expect(s, `version 2 lacks the section "${t}"`).toBeTruthy();
        changed.add(s!.id);
      }
      expect(byText(staffText)!.visibility).toBe('staff');
      expect(v2.sections.find((s) => s.id === 'illness')?.text).toBe(editText);
      for (const s of v2.sections) {
        if (changed.has(s.id)) {
          expect([dayBefore, dayAfter], `${s.id} was published without today's Denver date`).toContain(s.updatedOn);
        } else {
          const old = v1.sections.find((o) => o.id === s.id);
          expect(old, `version 2 holds an unexpected section ${s.id}`).toBeTruthy();
          expect(s.updatedOn, `${s.id} lost its last-updated date`).toBe(old!.updatedOn);
        }
      }
      for (const o of v1.sections) expect(v2.sections.some((s) => s.id === o.id), `version 2 dropped ${o.id}`).toBe(true);

      await replayFinished(r, id, 8 * MINUTES);
      const message = `Do you have a swimming pool? Ref ${letters(10)}.`;
      expect((await askAs(r, id, message)).status).toBe(200);
      const request = recorded.requests.find((q) => q.message.includes(message));
      expect(request, 'the parent message reached no model').toBeTruthy();
      expect(request!.snapshotText, 'the model input lacks the published parent section').toContain(parentText);
      expect(request!.snapshotText, 'the model input lacks the published edit').toContain(editText);
      expect(inputOf(request!), 'the model input holds a staff section').not.toContain(staffText);
      const { rows } = await sql().query('select snapshot_version from turns where sandbox_id = $1 and message = $2', [id, message]);
      expect(rows.map((t) => t.snapshot_version), 'the reply does not record version 2').toEqual([2]);
    },
    10 * MINUTES,
  );
});

describe('failures', () => {
  test(
    'a failed save leaves the draft unchanged and a failed publish creates no snapshot, with nothing internal in either response',
    async () => {
      const r = await loadRoutes(answeringModel().model);
      const id = await r.db.createSandbox(new Date());

      const before = await draftOf(id);
      const restoreDrafts = await failWrites('drafts', id);
      let saved;
      try {
        saved = await saveSection(r, id, { id: null, title: 'Oracle failing save', visibility: 'parent', text: `Body ${letters(8)}.` });
      } finally {
        await restoreDrafts();
      }
      expect(saved.status, 'a save the database refused did not fail').toBeGreaterThanOrEqual(400);
      expectNoLeak(saved.text, id, 'the failed save');
      expect(await draftOf(id), 'the failed save changed the draft').toEqual(before);

      expect((await saveSection(r, id, { id: null, title: 'Oracle pending section', visibility: 'parent', text: `Body ${letters(8)}.` })).status).toBeLessThan(300);
      const snapshots = await snapshotsOf(id);
      const restoreSnapshots = await failWrites('snapshots', id);
      let published;
      try {
        published = await publishDraft(r, id);
      } finally {
        await restoreSnapshots();
      }
      expect(published.status, 'a publish the database refused did not fail').toBeGreaterThanOrEqual(400);
      expectNoLeak(published.text, id, 'the failed publish');
      expect(await snapshotsOf(id), 'the failed publish created or changed a snapshot').toEqual(snapshots);
    },
    2 * MINUTES,
  );
});
