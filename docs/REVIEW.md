# Post-build review

Independent review of the cumulative diff from the empty baseline to the write-up milestone, read as one change. Written 2026-10-04, after the write-up landed and before the remediation pass. Milestone names below match `docs/WALKTHROUGH.md`.

## How the review ran

- **Reviewers:** three agents on a different model (Claude Fable 5.1) from the one that wrote the code (Claude Opus 5.5), each with a fresh context and none of the build's transcripts. None was given the build notes, so the authors' plans and retros could not anchor it.
- **Split by area:** pipeline and evals (`app/src/core`, `app/src/server`, `evals/`); data, routes and UI (`app/src/db`, `app/src/seed`, `app/src/app`, `proxy.ts`); infrastructure, CI and repo checks (`infra/`, `.github/`, `tests/repo/`, `.claude/`, supply chain).
- **Contract:** `docs/PRD.md`. `docs/DESIGN.md` and `README.md` were treated as claims to check, not as truth.
- **Evidence rule:** every finding was traced through the code, and most were demonstrated with scratch scripts or probes against a fixture-mode server outside the repo. Findings backed by reading alone are marked PLAUSIBLE. No repo file was modified, and no live model call or AWS call was made.
- **Spot check by the author:** the high finding (F1) and the floor false positives (F3) were re-run against the code before this file was written. Both reproduce.

## Summary

**34 findings: 1 high, 14 medium, 19 low.** Defects by milestone: baseline 2, infrastructure 6, contract and seed 2, eval harness 2, pipeline 12, parent view 0, operator view 5, demo hardening 1, demo explainers 0, write-up 2. F33 and F34 are observations, not milestone defects, so those counts sum to 32. H1 and H2 below are build-level notes, not findings.

The safety properties the build named held up. Tenant isolation, T5 (staff sections never reach a parent), the outcome ladder, draft and publish separation, S7 error bodies, the CSP, the IAM roles and the network shape were all checked and found sound. The defects cluster where no single milestone owned the whole picture:
- what the eval gate can and cannot detect (eval harness and pipeline);
- what the floor lexicons catch, in both directions (pipeline);
- what happens to the operator view's in-process replay when demo hardening's deploys and Reset demo arrive;
- whether the repo's checkers fail on what they forbid (baseline, infrastructure).

The write-up milestone describes the gated metrics as a safety floor that CI enforces. F1 and F2 show that claim is stronger than the gate. That correction is the most urgent item for a reviewer reading the README.

## Findings

Ordered by severity. Milestone attribution is by the commit that introduced the code.

### High

**F1. The eval gate passes a run in which nearly every trial failed to reach the model.** Eval harness.
- **Where:** `evals/src/metrics.ts:60-63`; `app/src/core/answer.ts:117`; `evals/src/runner.ts:195`.
- **Contract:** PRD Q7. README "Results" and DESIGN 14 present the gates as catching a broken answer path.
- **What happens:** a failed model call becomes a `handoff/system_error` with `outputValid: true`, and every gated metric treats that as safe:
  - `route_safe` passes because a handoff ranks at or above every expected outcome except urgent;
  - `grounded` passes because the reply isn't an answer;
  - `schema_valid` passes because a failed call has no invalid output;
  - `forbidden_clear` passes on the fixed text.
- **Evidence:** the real `runEval` and `answer()` over `evals/cases/`, with a model that throws on every non-urgent message, exited 0 with all four gates at 1.00 and "Trials that failed to reach the model: 174". The gate trips on an outage only if a failure lands on one of the 15 urgent trials.
- **Fix:** gate on a failure count of zero, or count a failed call as a `schema_valid` failure. CONFIRMED.

### Medium

**F2. The gated `grounded` metric cannot fail.** Pipeline.
- **Where:** `evals/src/cli.ts:56-60`; `app/src/core/answer.ts:89`.
- **What happens:** the metric re-runs `isGrounded` on the same text and the same cited sections the pipeline already checked and degraded on, so it can only catch wiring drift between the two.
- **Evidence:** a model that hallucinates "We open at 3:17 AM and the fee is $999" on every answerable case left `grounded` at 1.00 (`resolved_when_answerable` fell to 0). DESIGN 4.7 admits the correlation, but README and DESIGN 14 still report `grounded 1.00` as a result. CONFIRMED.

**F3. Urgent floors fire on everyday childcare messages, with no model call.** Pipeline.
- **Where:** `app/src/core/floors.ts:29` ("not responding"), `:49` ("is missing"), `:57` (`neglect\w*`), `:65` (`high ... pick up`), `:78`.
- **Contract:** PRD T9, T1.
- **What happens:** re-run by the author with `floorFor()`:

  | Message | Result |
  |---|---|
  | "The parent app is not responding when I try to pay tuition." | `urgent/emergency`; the reply tells the parent to call 911 |
  | "She has a high fever today, so I will pick her up early. Do I need a note?" | `urgent/safety`, though T9 says answer it |
  | "My daughter is missing her jacket, did anyone find it?" | `urgent/safety` |
  | "I neglected to pack her lunch today. What happens?" | `urgent/safety` |

- A grader can reach any of these on the live demo. CONFIRMED.

**F4. No metric or case can see an urgent-floor false positive.** Eval harness.
- **Where:** `evals/src/metrics.ts:113-117`; `evals/cases/`.
- **What happens:**
  - `floor_raised` excludes trials with no model proposal, and an urgent floor skips the model, so a false positive never counts.
  - A sweep found that no non-urgent case trips an urgent lexicon, so F3's class has no eval signal at all.
  - DESIGN 14's reading of `floor_raised 0.00` says nothing about the lexicon. CONFIRMED.

**F5. Plain statements of emergencies are not floored.** Pipeline.
- **Where:** `app/src/core/floors.ts:18-65`.
- **Contract:** PRD T1 together with T11.
- **What happens:** `floorFor()` returns `answer` for each of these:
  - "having trouble breathing right now"
  - "passed out and will not wake up"
  - "collapsed and is not waking up"
  - "swallowed a battery"
  - "Nobody can find my son at pickup"
  - "Her father showed up drunk to get her"
- If the model call then fails or times out, the parent gets "Sorry, something went wrong ... call the front desk", with no 911 text.
- `route_safe` 1.00 on the urgent stratum comes entirely from the model: none of the five urgent cases is floored. CONFIRMED.

**F6. `/api/ask` accepts unbounded `priorTurns`.** Pipeline. Two reviewers found it independently.
- **Where:** `app/src/app/api/ask/route.ts:19-22`; `app/src/core/assemble.ts:84`.
- **Contract:** PRD P3, S6, T12.
- **What happens:** only `message` is capped at 500 characters. A probe sent four 500 KB turns, and the route answered with the full history sent to the model.
- A client can also author `front_desk` turns, which the model reads as its own past replies. CONFIRMED; the cost impact is PLAUSIBLE.

**F7. A replay left `running` disables Publish for that sandbox, permanently.** Operator view.
- **Where:** `app/src/app/operator/operator-view.tsx:155`, `:173`, `:209`; `app/src/server/replay.ts:62-65`.
- **What happens:** `deploy.yml` recreates the app container on every push to main, and any replay in flight is left `running`. On the next load of `/operator`, the page polls forever and renders Publish disabled. The only way out is Reset demo.
- **Evidence:** probe with a `running` row: the server-rendered HTML had `<button disabled>Publish</button>`, and `/api/replay` kept answering `running: true`.
- DESIGN 4.10 and section 15 say "the next publish starts a new one", which is false. CONFIRMED.

**F8. A replay keeps calling the model after Reset demo deletes its sandbox.** Demo hardening.
- **Where:** `app/src/server/replay.ts:30-56`; `app/src/app/api/reset/route.ts:15-16`.
- **What happens:** the loop never re-checks its sandbox. A probe deleted the sandbox after 2 of 16 calls, and all 16 still ran.
- Each such reset wastes up to 60 calls and about 6 minutes of the shared 10 calls a minute. CONFIRMED.

**F9. The eval suite never runs before a change goes live, and the deploy has no gate or rollback.** Infrastructure.
- **Where:** `.github/workflows/deploy.yml:2-4, 43, 64-71`; `.github/workflows/evals.yml:2-15`; `infra/lib/front-desk-stack.ts:187`.
- **What happens:**
  - Milestones merge without pull requests, and `fd-eval` does not trust feature branches, so every eval run in history was a push to main.
  - Each one started at the same second as the deploy for that commit, and finished about 18 minutes after the change was serving.
  - Inside `deploy.yml`, `docker compose up -d` runs before the health and Q11 checks, and migrations run at container start. A failed check fails the run, but the new image keeps serving.
- DESIGN 9 documents that deploy is not gated on `ci`. It does not document the gap with the evals. CONFIRMED.

**F10. The infra identity tests guard the dead OIDC subject form and ignore the live one.** Infrastructure tests; the live form came from a later fix branch.
- **Where:** `infra/test/support/cfn.ts:10`; `infra/test/identity.test.ts:36-38, 141-165, 201-219`.
- **What happens:** a typo in `githubRepoImmutable` (`infra/cdk.json:8`) left all 33 infra tests green. A typo in the dead name form turned 7 red. The failure is closed (the roles stop working), so this is a coverage gap, not a privilege gap. CONFIRMED.

**F11. The secret-scan checker stays green when the CI scan is disabled.** Baseline.
- **Where:** `tests/repo/secret-scan.test.mjs:28-37, 60-87`.
- **What happens:** each of `continue-on-error: true`, `|| true` and an `if:` that never fires on the gitleaks step left the test passing.
- Sibling checkers test exactly these swallows: `infra/test/deploy-workflow.test.ts:142-146` and `evals/tests/workflows.test.ts:99-105`. CONFIRMED.

**F12. The `cdk deploy` deny rule misses the documented way `cdk` runs.** Baseline.
- **Where:** `.claude/settings.json:8`; `infra/package.json:7`; `tests/repo/claude-settings.test.mjs:53-58`.
- **What happens:** `Bash(cdk deploy:*)` is a prefix match. `pnpm --filter ./infra cdk deploy`, `pnpm -C infra cdk deploy`, `npx cdk deploy` and `cd infra && cdk deploy` all pass it, and DESIGN 11 names pnpm as how `cdk` is run.
- The checker probes only bare `cdk deploy`. CONFIRMED.

**F13. The evals path filter misses inputs that change eval results, and the `MODEL_ID` trigger evaluates the old model.** Pipeline.
- **Where:** `.github/workflows/evals.yml:6-15`; `evals/src/cli.ts:13, 44, 67`; `app/src/server/model.ts:9`.
- **What happens:**
  - Missed paths: `app/src/seed/**`, which builds every trial's snapshot; `app/package.json`; `pnpm-lock.yaml`.
  - A pull request changing only `MODEL_ID` in `infra/compose.prod.yml` triggers the eval, but the job sets no `MODEL_ID`, so it evaluates the hard-coded default and reports that default's ID.
- No run has been missed yet; the gap is latent. CONFIRMED.

**F14. A sandbox row with no content is a dead end the app never repairs.** Contract and seed.
- **Where:** `app/src/db/sandbox.ts:62-66`; `app/src/proxy.ts:31-32`; `app/src/app/api/ask/route.ts:35-36`.
- **What happens:** `createSandbox` inserts the row and writes the seed in a second transaction. If the seed write fails, `seen()` still reports the sandbox as existing, so it is never replaced. Both views render the unavailable text with no Reset demo, and each visit keeps the row from idle deletion.
- A malformed cookie value reaches the same state through `sandbox-cookie.ts:17`, and makes `/api/sections`, `/api/publish` and `/api/replay` return 500.
- CONFIRMED for the mechanism. A seed write actually failing is PLAUSIBLE.

**F15. Sandbox creation is unbounded.** Pipeline.
- **Where:** `app/src/proxy.ts:31-32`; `app/src/app/api/ask/route.ts:35-36`.
- **What happens:** every request without a cookie writes a full seed, about 18 to 20 KB. 25 concurrent cookieless requests made 25 sandboxes. One request a second for a day is about 86,000 sandboxes on a 20 GB disk.
- CONFIRMED for the mechanism; the impact is PLAUSIBLE.

### Low

**F16. Seeded Picture Day can land on a holiday.** Contract and seed. `app/src/seed/calendar.ts:44-57` skips only weekends. `seed(2026-09-06T18:00Z)` puts Picture Day (open) and Labor Day (closed) on the same date, so the model input carries both. The Today card says closed. CONFIRMED.

**F17. Grounding misses money written as "50 dollars".** Pipeline. `app/src/core/grounding.ts:36` requires `$`; `:13-20` silently skips "17:30 PM"; `:41-43` drops the year and weekday from dates. A probe kept "The late fee is 50 dollars" as answered (the source says $15). CONFIRMED.

**F18. A correct hyphenated hours answer is degraded.** Pipeline. `app/src/core/grounding.ts:38` reads a bare "5:30" as 05:30, so "open 7:00-5:30" becomes `grounding_failed`. This is the safe direction, but it costs `resolved_when_answerable`. CONFIRMED.

**F19. Throttle retries make up to five Bedrock calls against one reservation of the daily cap.** Pipeline. `app/src/core/answer.ts:58-79`; `app/src/server/ask.ts:76-78`; `replay.ts:38`. PRD S6 counts model calls. CONFIRMED by trace.

**F20. Replay re-asks with no prior turns, and counts a model failure as not answered.** Operator view. `app/src/server/replay.ts:39-42`. A timeout during replay keeps a covered gap open and reads to the operator as a phrasing the new section missed. PLAUSIBLE.

**F21. Gap joining splits singular and plural labels.** Pipeline. `app/src/core/gaps.ts:6-16` uses unstemmed Jaccard, so "Sibling discounts" opens a new gap beside "Sibling discount". `sandbox.ts:221-231` selects then inserts with no unique index, so a race can create duplicate gaps. CONFIRMED for the joining; the race is PLAUSIBLE.

**F22. A sensitive-floored message can be filed into a gap.** Pipeline. `app/src/core/answer.ts:131-141`: at equal rank the model's reason is kept, so a custody message with model reason `not_in_source` is filed. PRD 5.2 says sensitive replies are not filed. CONFIRMED.

**F23. DESIGN claims that do not match the code.** Pipeline.
- DESIGN 4.4 says `[data:calendar]`; the code uses `calendar` (`assemble.ts:49`).
- DESIGN 4.7 and 7 promise unit tests for the extractor and the lexicons, but no test imports `extractValues`, `isGrounded` or `floorFor`, and the bare-word non-triggers have no direct test.
- A model that returns a valid `handoff/system_error` is recorded with `failure: null`, invisible to the failure count.

CONFIRMED.

**F24. Reasons render raw in the operator's Questions rows.** Operator view. `app/src/app/operator/questions.tsx:57` de-underscores the enum ("not in source") instead of mapping through `copy.ts` (PRD A8, standing rule 5). The copy scan only flags literals. CONFIRMED.

**F25. `forSandbox().write()` does not clear `replays`.** Operator view. `app/src/db/sandbox.ts:71-73` claims to replace everything the sandbox holds; `replays` was added in 07 and left out. Only tests call it. CONFIRMED.

**F26. Tests that do not test what they name.** Operator view.
- The isolation test's kinds cover only what `read()` returns, so `replays` is outside them, and DESIGN 7's "for every kind of sandbox data" overstates (`app/tests/db/sandbox.test.ts:128-237`).
- The `<n> of 16` assertions in `replay.spec.ts:95` and `replay-time.spec.ts:52` are satisfied by the final "16 of 16" render.
- The 7-minute bound runs against the fixture model only.

CONFIRMED by reading.

**F27. The production environment's branch policy holds S3 up, and nothing records it.** Infrastructure. The deploy role trusts `environment:production` (`front-desk-stack.ts:200`). Only the environment's `main` branch policy (GitHub settings) stops a feature branch from minting that subject. It is correct today, but no doc or test names it. CONFIRMED.

**F28. The budget alert is forecast-only.** Infrastructure. `front-desk-stack.ts:225-235`. AWS needs weeks of history before it forecasts, and there is no ACTUAL threshold as a fallback. PLAUSIBLE.

**F29. The origin can be fronted by any CloudFront distribution.** Infrastructure. `front-desk-stack.ts:84, 143-146` admit the shared CloudFront prefix list with no origin-verification header. Another distribution could reach the app without this one's redirect and headers. PLAUSIBLE.

**F30. Floating base images and mutable ECR tags.** Infrastructure. `app/Dockerfile:1, 12` uses `node:22-slim`; `postgres:16` is used in compose and CI; the ECR repository has no `IMMUTABLE` tag setting. CONFIRMED as configuration.

**F31. The README's local setup omits gitleaks.** Write-up. `pnpm test` spawns `gitleaks` (`tests/repo/support/repo.mjs:65-67`), but README "Run it locally" names only `DATABASE_URL`. CONFIRMED.

**F32. The README and DESIGN overstate the eval gate.** Write-up.
- README "Results" says the gated metrics are "the safety floor" and that the workflow "fails if any of them drops below 1.00", which F1 and F2 qualify.
- DESIGN section 15 repeats 4.10's false recovery claim (F7).

CONFIRMED.

**F33. Eval runs sit at the Q10 time bound.** Observation, not counted. Pacing alone is 64 × 3 × 6 s = 19.2 minutes, and the last five runs took 19:39 to 19:48. One more case, or one throttle retry, crosses PRD Q10's 20 minutes.

**F34. 227 MB of tracked logs.** Not counted against a milestone; see H1.

## Feature-level observations

**H1. Mutation-control logs dominated the repository at review time.** About 227 MB of the tracked tree was the harness's mutation-control run logs; everything else was 1.7 MB. Four files were 49 to 61 MB each, the largest 1,859,259 lines. `tests/repo/clean-clone.test.mjs` copied all of it on every `pnpm test`.
- The cause was the harness (feature-chunker), which writes every control run's full output, and the choice to track build artifacts. No product code caused it.
- Fix in the harness: cap or summarize the mutation logs.
- Fix in the repo: the build notes and their logs were removed from the tree and from history before the repo went public.

**H2. Gates the milestones could not see across.** The findings group into four seams, each of which no per-milestone gate could examine:
- F1, F2 and F4 sit between the eval metrics (eval harness) and the pipeline's failure modes (pipeline).
- F7 and F8 sit between the operator view's in-process replay and demo hardening's deploys and Reset.
- F9 sits between the deploy (infrastructure) and the eval triggers (pipeline), under the decision to merge without pull requests.
- F10 to F12 are checkers that pass when the thing they guard is disabled.

## Remediation

The findings go to a findings-remediation workflow, one commit per finding, test first. Suggested order:
1. **First, documentation only:** correct the README's and DESIGN 14's description of the gate (F32, F1, F2), and correct DESIGN 4.10 and 15's recovery claim (F7). These are cheap, and they are what a reviewer reads.
2. **Next, if time allows:** F3, the urgent-floor false positives a grader can hit. Narrow `not responding`, `is missing`, `neglect\w*` and `high ... pick up`, and add correlation-breaker cases. Adding eval cases needs a human and the `oracle-change` label.
3. **Then:**
   - F1 (gate on the failure count);
   - F6 (cap `priorTurns`);
   - F7 and F8 (replay recovery and cancellation);
   - F5 (more urgent phrases);
   - the rest in severity order.
