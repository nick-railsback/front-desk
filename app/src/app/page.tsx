// The parent view (PRD P1): the Today card, then the Try this strip and the
// conversation. The proxy has already put this browser in a sandbox; with no
// sandbox, or no database, the page shows a fixed message with the phone
// number instead.

import { headers } from 'next/headers';
import { PARENT } from '../core/copy';
import { type TodayCard as Card, todayCard } from '../core/today';
import { forSandbox } from '../db/sandbox';
import { SANDBOX_HEADER } from '../server/sandbox-cookie';
import { ParentView } from './parent/parent-view';
import { PhoneLink } from './parent/phone';
import { TodayCard } from './parent/today-card';

export const dynamic = 'force-dynamic';

async function loadCard(): Promise<{ card: Card; dismissed: boolean } | null> {
  const sandboxId = (await headers()).get(SANDBOX_HEADER);
  if (!sandboxId) return null;
  try {
    const access = forSandbox(sandboxId);
    const [{ structured }, dismissed] = await Promise.all([access.context(), access.tryThisDismissed()]);
    return { card: todayCard(structured, new Date()), dismissed };
  } catch (err) {
    console.error('parent view: no Today card:', err);
    return null;
  }
}

export default async function Home() {
  const loaded = await loadCard();
  if (!loaded) {
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
      <TodayCard card={loaded.card} />
      <ParentView tryThis={{ dismissed: loaded.dismissed }} />
    </main>
  );
}
