// The demo center as data: `seed(now)` returns a fresh copy of Juniper Hill
// with every date relative to `now`. Pure: the clock is passed in, never read.

import type { Reply, Section } from '../core/types';
import { alerts, calendar, menus } from './calendar';
import { center, programs, registrationFee } from './center';
import { denverDate } from './dates';
import { history } from './history';
import { sections } from './sections';

export type Center = {
  name: string;
  city: string;
  timezone: string;
  phone: string;
  email: string;
  director: string;
  officeHours: string;
};

export type Program = {
  id: string;
  name: string;
  ages: string;
  hours: string;
  weeklyTuition: string;
};

export type CalendarEntry = {
  id: string;
  date: string; // YYYY-MM-DD in America/Denver
  name: string;
  status: 'open' | 'closed';
  time: string | null;
};

export type Menu = { date: string; items: string[] };

export type Alert = { id: string; text: string; startsAt: string; expiresAt: string };

export type Question = { id: string; text: string; askedAt: string; reply: Reply };

export type Gap = { id: string; label: string; status: 'open'; questionIds: string[] };

export type Snapshot = { version: number; sections: Section[] };

export type Seed = {
  structured: {
    center: Center;
    programs: Program[];
    registrationFee: string;
    calendar: CalendarEntry[];
    menus: Menu[];
    alerts: Alert[];
  };
  snapshots: Snapshot[];
  draft: { sections: Section[] };
  questions: Question[];
  gaps: Gap[];
};

export function seed(now: Date): Seed {
  const creation = denverDate(now);
  const published = sections(creation);
  const { questions, gaps } = history(now, creation, published);
  return {
    structured: {
      center: { ...center },
      programs: programs.map((p) => ({ ...p })),
      registrationFee,
      calendar: calendar(creation),
      menus: menus(creation),
      alerts: alerts(creation),
    },
    snapshots: [{ version: 1, sections: published }],
    draft: { sections: structuredClone(published) },
    questions,
    gaps,
  };
}
