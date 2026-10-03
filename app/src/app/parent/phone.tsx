// The front desk's number as a tap-to-call link, and text with every
// occurrence of the number turned into that link. Fixed texts carry the
// number inline, so they stay byte-identical to what core built.

import { Fragment } from 'react';
import { PHONE, PHONE_HREF } from '../../core/copy';

export function PhoneLink() {
  return (
    <a className="phone" href={PHONE_HREF}>
      {PHONE}
    </a>
  );
}

export function PhoneText({ text }: { text: string }) {
  return text.split(PHONE).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <PhoneLink />}
      {part}
    </Fragment>
  ));
}
