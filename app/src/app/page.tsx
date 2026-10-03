// The parent view (PRD P1): the Today card, then the conversation. The proxy
// has already put this browser in a sandbox; with no sandbox, or no database,
// the page shows a fixed message with the phone number instead.

import { headers } from 'next/headers';
import { PARENT } from '../core/copy';
import { type TodayCard as Card, todayCard } from '../core/today';
import { forSandbox } from '../db/sandbox';
import { SANDBOX_HEADER } from '../server/sandbox-cookie';
import { ParentView } from './parent/parent-view';
import { PhoneLink } from './parent/phone';
import { TodayCard } from './parent/today-card';

export const dynamic = 'force-dynamic';

async function loadCard(): Promise<Card | null> {
  const sandboxId = (await headers()).get(SANDBOX_HEADER);
  if (!sandboxId) return null;
  try {
    const { structured } = await forSandbox(sandboxId).context();
    return todayCard(structured, new Date());
  } catch (err) {
    console.error('parent view: no Today card:', err);
    return null;
  }
}

export default async function Home() {
  const card = await loadCard();
  if (!card) {
    return (
      <main>
        <p className="unavailable">
          {PARENT.unavailable} <PhoneLink />
        </p>
      </main>
    );
  }
  return (
    <main>
      <TodayCard card={card} />
      <ParentView />
    </main>
  );
}
