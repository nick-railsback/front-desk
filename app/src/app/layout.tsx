// Every page: the role switcher and the note that the data is fictional
// (PRD D6, D8). Parent is the current view until chunk 07 adds the operator
// view and makes the switcher follow the route.

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PARENT } from '../core/copy';
import './globals.css';

export const metadata: Metadata = { title: PARENT.title };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <h1>{PARENT.heading}</h1>
          <nav aria-label={PARENT.roles}>
            <ul className="roles">
              <li>
                <Link href="/" aria-current="page">
                  {PARENT.parent}
                </Link>
              </li>
              <li>
                <Link href="/operator">{PARENT.operator}</Link>
              </li>
            </ul>
          </nav>
          <p className="fictional">{PARENT.fictional}</p>
        </header>
        {children}
      </body>
    </html>
  );
}
