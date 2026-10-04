# Front Desk

A mobile-first AI front desk for one fictional childcare center, Juniper Hill. Parents ask questions in text and get answers from the center's own information, with citations, or a plain handoff or urgent reply when the front desk shouldn't answer. Operators see every question, see which subjects the center's information doesn't cover (gaps), write the missing policy once, publish it, and watch a replay answer those questions.

The center, its people and its questions are fictional.

## Try it

**Demo:** https://daxy402lmcl8s.cloudfront.net

Each browser gets its own copy of the center. The "Try this" strip walks the loop:

1. As a parent, tap "Do you offer a discount for siblings?". The front desk says it doesn't know, and files the question under the Sibling discount gap.
2. Switch to Operator, then Gaps.
3. Answer the gap and publish.
4. Watch the replay re-ask every open gap's questions against the new version.
5. Ask again as a parent. The answer now cites the section you wrote.

The loop takes about two minutes, not one. Steps 1 to 3 are quick; the replay in step 4 takes about 100 seconds, because it re-asks 17 questions (16 seeded, plus yours) one at a time at the AWS account's limit of 10 model calls a minute. AWS declined a quota increase.

Every visitor shares that limit, and a cap of 3,000 model calls a day. A message over a limit gets a fixed notice instead of a model call. A message the model can't answer within 15 seconds, because other visitors are using the limit, gets a fixed "something went wrong" handoff. "Reset demo" starts a fresh copy.

## Results

From the latest live eval: [`evals.yml` on `main`](https://github.com/nick-railsback/front-desk/actions/runs/37212986619), Claude Haiku 4.5 on Amazon Bedrock, git SHA `b9b7488`, 2026-10-04 15:26 UTC. No trial failed to reach the model.

| Measure | Value |
|---|---|
| Cases, trials | 64 cases, 3 trials each, 192 trials |
| Gated: `route_safe`, `grounded`, `schema_valid`, `forbidden_clear` | 1.00 each |
| `resolved_when_answerable` (target 0.85) | **0.52** |
| Latency p50 | 1.77 s (p95 2.30 s) |
| Cost per reply | $0.0040 |

- **The gated metrics held on this run, and they check less than their names suggest.** Every trial routed at or above its expected outcome, every number in an answer appeared in the text it cited, every model output passed validation, and no forbidden string appeared. The [independent review](docs/audits/2026-10-04-front-desk-feature-close.md) found two limits, one now fixed. A model call that failed became a safe handoff that every gate passed, so an outage could pass the run; a failed call now fails `schema_valid` (F1). `grounded` re-runs the pipeline's own grounding check, so it catches wiring drift between the two, not answers the guard misses (F2).
- **The eval reports; it does not block a deploy.** `evals.yml` runs on pull requests that change answer behavior and on every push to `main`, and fails below 1.00. On `main` it runs alongside the deploy, so a regression is reported about 18 minutes after it is live (F9).
- **`resolved_when_answerable` misses its target.** On the 31 cases that should be answered, the front desk answered 52% of trials. It errs toward caution: it hands off rather than answering wrongly. The largest miss is `medical_policy` at 0.00, where every symptom question ("101 temp last night, can she come in?") routed above an answer. The likely cause, not yet confirmed, is the instruction to mark a child who "may be hurt, sick, or in danger right now" as urgent, which collides with policy questions about a sick child. The report records which trials failed, not which outcome each one got, so the next step is to log per-trial outcomes and then tune that instruction against this stratum.
- **These numbers are evidence about these 64 cases only.** An agent drafted every case from the PRD before the answer prompt existed; I reviewed and edited each one. None is held out from me.

Per-stratum results are in [`docs/DESIGN.md` section 14](docs/DESIGN.md#14-results). The run page carries the summary and `report.json`.

## How it works

- **One model call per message**, forced into a reply schema: outcome, reason, text, citations, topic. Code owns every branch around it.
- **Code decides what the model can't be trusted with.** Keyword floors catch urgent and sensitive messages before the call (an urgent floor skips the call entirely). After the call, citations must name real parent-visible sections, and every price, time, date and temperature in an answer must appear in the cited text, or the answer is degraded.
- **No retrieval.** A center's information is a few thousand tokens, so the whole published version goes in context.
- **One EC2 instance** running Next.js and Postgres in Docker Compose behind CloudFront. The app reaches Bedrock through its instance role. There are no long-lived credentials anywhere: no model API key, no cloud keys in GitHub, CI deploys through OIDC.

The full design, trade-offs and decisions are in [`docs/DESIGN.md`](docs/DESIGN.md).

## Deliberately not built

Designed for and written up in [PRD section 12](docs/PRD.md#12-out-of-scope-designed-for-written-up-not-built), not implemented: Spanish parity, platform identity and roles, structured data from systems of record, handoffs into messaging and a CRM, a public website widget, answers about a parent's own child, actions with side effects, voice and SMS, PDF handbook import, per-center golden questions, saving a staff reply to the handbook, fleet-level gap insights, row-level security, and retrieval over large corpora.

## Known limits

The full list is in the [feature-close review](docs/audits/2026-10-04-front-desk-feature-close.md). The ones a visitor or reviewer is most likely to meet:

- **The urgent keyword floors over-trigger on some everyday messages.** "The parent app is not responding" or "She has a high fever, so I will pick her up early" gets the urgent reply with no model call. The floors also miss some plain emergencies ("having trouble breathing right now"), which then depend on the model. No eval case covers either class (F3 to F5).
- **The eval cases' protection has two gaps.** `oracle-guard.yml` fails a pull request that changes `evals/cases/` without the `oracle-change` label, but this build merged each chunk to `main` without a pull request, so the guard never ran on it; my review of each diff was the check. The deny rules in `.claude/settings.json` stop an agent's Edit and Write tools from touching `evals/cases/`, but not a shell command.
- **Traffic from CloudFront to the instance is plain HTTP.** Acceptable for fictional data; production would terminate TLS at the origin.

## Accessibility

Automated axe checks run in CI on the parent view in every reply state and on each operator area (PRD A1).

**VoiceOver pass (PRD A9).** On 2026-10-04 I ran VoiceOver on iOS Safari through the demo loop on the deployed app and found nothing to fix. A WAVE check of the deployed pages on desktop and mobile also found nothing to fix.

## Run it locally

```
pnpm install
docker compose -f infra/compose.dev.yml up -d db
pnpm dev          # scripted fixture model, no AWS needed
pnpm test         # needs DATABASE_URL (see infra/compose.dev.yml) and gitleaks on PATH
pnpm test:e2e
pnpm eval         # live model calls; needs an AWS SSO profile
```

## How it was built

Requirements live in [`docs/PRD.md`](docs/PRD.md). The work ran as ten chunks. Each had a spec and a review before commit, and all but this write-up had a test oracle written before the code and frozen at plan approval. Each chunk's spec, plan, review notes and retro are in [`docs/chunks/front-desk/`](docs/chunks/front-desk/).
