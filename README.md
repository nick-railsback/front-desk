# Front Desk

**Demo:** https://daxy402lmcl8s.cloudfront.net (works on a phone; every visitor gets a private copy of the center)

Center staff answer the same questions all day; parents ask after hours and get voicemail. Front Desk answers parents from the center's own handbook, says plainly when it can't, routes urgent and sensitive messages to a person, and shows the operator which questions the handbook doesn't answer yet.

## The loop that makes it better every week

Most AI assistants fail quietly. Front Desk turns every unanswered question into work the operator can finish.

1. A parent asks something the handbook doesn't cover ("Do you offer a sibling discount?"). The front desk says so, gives the phone number, and files the question under a **gap**: a subject the center hasn't written up.
2. The operator opens **Gaps** and sees the subjects, ranked by how many parents asked, with the parents' own wording beside each.
3. **Answer this** opens a new handbook section beside those questions. The operator writes the policy; the system never writes it for them.
4. **Publish** sends the new text live and **replays** every open gap's questions against it. The operator watches "7 of 8 now answered" and the gap closes.

The handbook grows from what parents actually ask. Hours, calendar, menus and tuition come from center records; operators only write policy. The Try this strip walks you through the loop in about two minutes.

## What parents get

- **Answers with receipts.** Every answer cites the handbook section it came from. Tap it and read the exact text.
- **Honesty over guessing.** If the handbook doesn't cover it, the front desk says so. If a generated sentence doesn't match the handbook, parents see the handbook's words.
- **The right exit.** An emergency gets "call 911, then call the center" before any AI runs. Custody, billing and complaints go to a staff member. Anything else goes to the front desk in one tap, with a note on when staff will see it.

## Why it can be trusted

- **The AI proposes, code decides.** One model call per message, forced into a fixed shape: answer, hand off, or urgent, plus citations. Code checks every price, time, date and temperature against the cited text. A wrong fee never ships.
- **Safety text is written by people.** Urgent and handoff replies are fixed wording, never generated. No API keys or cloud secrets exist anywhere.
- **Measured before every release.** 64 test questions across 14 categories, each run 3 times against the live model. Latest run: 100% of 192 trials routed safely, grounded in the cited text and leaked nothing staff-only, at a median 1.8 seconds and $0.004 per reply.

## What's next on the platform

Designed for, not built: Spanish, platform sign-in and roles, live calendar and billing data, handoffs into the platform's messaging and CRM, questions about a parent's own child, and fleet-level insight into which gaps every center shares.

The center and everyone in it are fictional.
