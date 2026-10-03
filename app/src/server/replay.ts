// Replay (PRD O10, O11; DESIGN 4.10): after a publish, each open gap's most
// recent questions are re-run against the new snapshot through the pure
// pipeline. Nothing is stored as a turn, filed into a gap, or counted against
// the sandbox's message limits; each model call is reserved against the
// global daily cap, as ask() reserves it. A gap whose replayed questions all
// come back answered is resolved.
//
// One question at a time: the account allows 10 model calls a minute, and a
// burst would come back throttled. answer() already retries a throttled call
// inside its deadline; a question still throttled after that waits once more
// and is re-run once.

import { renderDataSections } from '../core/assemble';
import { answer } from '../core/answer';
import { floorFor } from '../core/floors';
import type { Clock, Model } from '../core/types';
import type { ReplayResult } from '../db/schema';
import { forSandbox, reserveModelCall } from '../db/sandbox';
import { denverDate } from '../seed/dates';
import { globalDailyModelCalls } from './ask';

const THROTTLED_PAUSE_MS = 6000;

export async function runReplay(sandboxId: string, replayId: string, deps: { model: Model; clock: Clock }): Promise<void> {
  const { model, clock } = deps;
  const access = forSandbox(sandboxId);
  try {
    const now = new Date(clock.now());
    const today = denverDate(now);
    const context = await access.context();
    const { calendar } = context.structured;
    const snapshot = { version: context.snapshot.version, sections: [...context.snapshot.sections, ...renderDataSections(context.structured, now)] };

    // True when the question comes back answered. A question the global cap
    // has no room for makes no model call and is not answered.
    const answered = async (message: string): Promise<boolean> => {
      for (let attempt = 0; ; attempt++) {
        if (floorFor(message).floor !== 'urgent' && !(await reserveModelCall(today, globalDailyModelCalls()))) return false;
        const record = await answer({ message, priorTurns: [], now }, { snapshot, calendar, openGapLabels: context.openGapLabels, model, clock });
        if (attempt > 0 || !record.failure?.includes('ThrottlingException')) {
          if (record.failure) console.error(`replay: ${record.failure}`);
          return record.reply.reason === 'answered';
        }
        await clock.sleep(THROTTLED_PAUSE_MS);
      }
    };

    const results: ReplayResult[] = [];
    let completed = 0;
    for (const gap of await access.replayQuestions()) {
      let yes = 0;
      for (const message of gap.messages) {
        if (await answered(message)) yes += 1;
        completed += 1;
        await access.recordReplayProgress(replayId, completed);
      }
      const replayed = gap.messages.length;
      results.push({ gapId: gap.id, label: gap.label, replayed, answered: yes, resolved: replayed > 0 && yes === replayed });
    }
    await access.finishReplay(replayId, results);
  } catch (err) {
    console.error('replay failed:', err);
    await access.failReplay(replayId).catch((e) => console.error('replay: could not record the failure:', e));
  }
}
