// The Today card (PRD P2): what todayCard() computed, shown as is.

import { PARENT } from '../../core/copy';
import type { TodayCard as Card } from '../../core/today';

export function TodayCard({ card }: { card: Card }) {
  return (
    <section className="today" aria-labelledby="today-heading">
      <h2 id="today-heading">{PARENT.today}</h2>
      <p className="today-date">{card.date}</p>
      <p>{card.status}</p>
      {card.alerts.length > 0 && (
        <>
          <h3>{PARENT.alerts}</h3>
          <ul className="alerts">
            {card.alerts.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {card.hours.length > 0 && (
        <>
          <h3>{PARENT.hours}</h3>
          <ul>
            {card.hours.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </>
      )}
      <h3>{PARENT.menu}</h3>
      <ul>
        {card.menu.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </section>
  );
}
