// Every page: the role switcher and the note that the data is fictional
// (PRD D6, D8).

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PARENT } from '../core/copy';
import './globals.css';
import { RoleSwitcher } from './role-switcher';

export const metadata: Metadata = { title: PARENT.title };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <h1>{PARENT.heading}</h1>
          <RoleSwitcher />
          <p className="fictional">{PARENT.fictional}</p>
        </header>
        {children}
      </body>
    </html>
  );
}
