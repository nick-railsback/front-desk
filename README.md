# Front Desk

**Demo:** https://daxy402lmcl8s.cloudfront.net (works on a phone; every visitor gets a private copy of the center)

Center staff answer the same questions all day: hours, tuition, sick policy, what's for lunch. Parents ask after hours and get voicemail. Front Desk answers parents from the center's own handbook, says plainly when it can't, routes urgent and sensitive messages to a person, and shows the operator exactly which questions the handbook doesn't answer yet, so they can fix each one once.

## The loop that makes it better every week

Most AI assistants fail quietly: a parent gets "I'm not sure", and nobody at the center ever knows. Front Desk turns every unanswered question into work the operator can see and finish.

1. A parent asks something the handbook doesn't cover ("Do you offer a sibling discount?"). The front desk says so, gives the phone number, and files the question under a **gap**: a subject parents ask about that the center hasn't written up.
2. The operator opens **Gaps** and sees the subjects, ranked by how many parents asked, with the parents' own wording beside each.
3. **Answer this** opens a new handbook section next to those questions. The operator writes the policy in their words. The system never writes policy for them.
4. **Publish** sends the new text live and **replays** every open gap's questions against it. The operator watches the count come back ("7 of 8 now answered") and a fully answered gap closes.

The handbook grows from what parents actually ask. The operator also sees every question from the last 7 days, the reply exactly as the parent saw it, and which ones were sent to the front desk. Hours, calendar, menus, tuition and contacts come from center records; operators only ever write policy.

In the demo, the Try this strip walks you through the loop in about two minutes. The replay takes around 100 seconds because this demo account allows 10 model calls a minute, shared by all visitors. Reset demo gives you a fresh center.

## What parents get

- **Answers with receipts.** Every answer cites the handbook section or center record it came from. Tap the citation and read the exact text.
- **Honesty over guessing.** If the handbook doesn't cover it, the front desk says so and gives the number. If a generated sentence doesn't match the handbook, parents see the handbook's words instead.
- **The right exit.** An emergency (a child not breathing, a seizure) gets "call 911, then call the center" before any AI runs. Custody, billing disputes and complaints go to a staff member. Anything else can be sent to the front desk in one tap, with an honest note about when staff will see it.
- **Today at a glance.** Open or closed, hours, menu and alerts, computed from the center's records with no AI involved.

## Why it can be trusted

- **The AI proposes, code decides.** One model call per message, forced into a fixed shape: answer, hand off, or urgent, plus citations. Code checks every price, time, date and temperature in an answer against the cited text before a parent sees it. A wrong fee never ships.
- **Safety text is written once, by people.** Urgent and handoff replies are fixed wording, never generated. No API keys or cloud secrets exist anywhere in the system.
- **Measured, not vibes.** 64 test questions across 14 categories, from emergencies and privacy to panicked wording about nothing ("EMERGENCY!! When is picture day??"), each run 3 times against the live model before a change ships.

## Results, honestly

Live run on 2026-10-04 (build `b9b7488`), 192 trials, Claude Haiku 4.5:

| Measure | Result |
|---|---|
| Routed at or above the safe outcome, every fact backed by the cited text, well-formed reply, staff-only information never surfaced | 100% of trials, each |
| Answerable questions actually answered | **52%** (target 85%) |
| Median reply time, cost per reply | 1.8 seconds, $0.004 |

No message was routed below where it belonged, and no answer stated a fact its cited text didn't back up. The cost is that it hands off too often: caution over coverage. The largest miss is sick-child policy questions ("101 temp last night, can she come in?"), which it treats as emergencies. The likely cause is one sentence in the instructions, and the fix is measurable against the same suite. These numbers are evidence about these 64 questions, one center, English only.

## What's next on the platform

Designed for, not built in this timebox: Spanish (starting with the safety checks, not translation), sign-in with platform roles, real calendar and billing data from the platform's records, handoffs into its messaging and CRM, questions about a parent's own child, and fleet-level insight into which gaps every center shares.

The center, its people and its questions are fictional.
