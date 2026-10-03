'use client';

// The Parent / Operator switcher (PRD D6): the link to the current view is
// marked as the current page.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PARENT } from '../core/copy';

const VIEWS = [
  { href: '/', name: PARENT.parent },
  { href: '/operator', name: PARENT.operator },
];

export function RoleSwitcher() {
  const pathname = usePathname();
  return (
    <nav aria-label={PARENT.roles}>
      <ul className="roles">
        {VIEWS.map((v) => (
          <li key={v.href}>
            <Link href={v.href} aria-current={pathname === v.href ? 'page' : undefined}>
              {v.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
