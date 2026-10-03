// `pnpm eval`: runs every case in evals/cases/ through the same pure answer()
// the app ships, with the model getModel() picks (Bedrock, or the fixture
// model under MODEL_MODE=fixture), and writes the report to evals/reports/.
// No database: each trial's sandbox content is seed(case.now).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answer } from '../../app/src/core/answer';
import { renderDataSections } from '../../app/src/core/assemble';
import { isGrounded } from '../../app/src/core/grounding';
import type { Reply, Section } from '../../app/src/core/types';
import { seed } from '../../app/src/seed/index';
import { realClock } from '../../app/src/server/clock';
import { MODEL_ID, getModel } from '../../app/src/server/model';
import { runEval } from './runner';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = process.env.MODEL_MODE === 'fixture';

// Claude Haiku 4.5, USD per token: $1 input, $0.10 cache read, $5 output per
// million. First-party API rates from the claude-api skill's model table
// (cached 2026-06-24), read 2026-10-03. Bedrock bills separately and these
// are not yet checked against its price list.
const PRICES = { input: 1 / 1e6, cachedInput: 0.1 / 1e6, output: 5 / 1e6 };

// The policy snapshot plus the six data sections, as the app renders them.
function withData(sections: Section[], now: Date): Section[] {
  return [...sections, ...renderDataSections(seed(now).structured, now)];
}

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const model = getModel();
const { exitCode } = await runEval({
  casesDir: path.join(here, '..', 'cases'),
  answer: async ({ message, priorTurns, now, snapshot }) => {
    const content = seed(now);
    return answer(
      { message, priorTurns, now },
      {
        snapshot: { version: snapshot.version, sections: withData(snapshot.sections, now) },
        calendar: content.structured.calendar,
        openGapLabels: content.gaps.filter((g) => g.status === 'open').map((g) => g.label),
        model,
        clock: realClock,
      },
    );
  },
  groundingCheck: (reply: Reply, snapshot, now) => {
    if (reply.outcome !== 'answer' || reply.reason !== 'answered') return true;
    const cited = withData(snapshot.sections, now).filter((s) => reply.citations.some((c) => c.sectionId === s.id));
    return isGrounded(reply.text, cited);
  },
  // Bedrock allows Haiku 4.5 10 requests a minute on this account: one trial
  // start every 6 s. The fixture model has no quota.
  concurrency: fixture ? 8 : 2,
  minStartIntervalMs: fixture ? 0 : 6000,
  clock: realClock,
  gitSha: gitSha(),
  modelId: fixture ? 'fixture' : MODEL_ID,
  prices: PRICES,
  outDir: path.join(here, '..', 'reports'),
  log: (line) => console.log(line),
});
// A model call's 15 s deadline timer can outlive its trial; do not wait on it.
process.exit(exitCode);
