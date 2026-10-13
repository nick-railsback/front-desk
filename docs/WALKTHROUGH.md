# How it was built

The build in order: what each milestone delivered, why it came when it did, and where its code lives, then answers to the questions a reader is most likely to ask. Every milestone ran through the [feature-chunker](https://github.com/nick-railsback/feature-chunker) lifecycle: a spec citing PRD requirements, acceptance tests written blind from that spec by an isolated agent and proven failing, a plan gate, implementation, a verification gate that re-runs the frozen tests, and a retro. The milestone notes themselves are not in this repo. Numbers are from the live eval on `main` dated 2026-10-04.

## The 30-second version

- **What:** a mobile-first AI front desk for one fictional center. Parents get answers from the center's own information with citations, or a plain handoff or urgent reply. Operators see which questions the information doesn't cover (gaps), write the missing section once, publish, and watch a replay answer those questions.
- **The bet:** trust over coverage. One model call proposes; code decides everything the model can't be trusted with (floors before, citation and grounding checks after, fixed safety text).
- **The honest number:** every gated safety metric held at 1.00 on 192 trials, but the front desk answered only 48% of answerable questions against a target of 85%. It errs toward handing off. I know the likely cause and the first fix.

## 1. Baseline
- What: an empty repo that installs reproducibly, runs `pnpm test` green from a fresh clone, blocks secrets at commit time and scans full history in CI.
- Why: the supply-chain and secret protections had to exist before the first dependency or credential could, not be retrofitted after.
- Where: `pnpm-workspace.yaml` (`allowBuilds`, `minimumReleaseAge`), `lefthook.yml` (gitleaks pre-commit), `.claude/settings.json` (deny rules), `.github/workflows/ci.yml`, `tests/repo/`.

## 2. Infrastructure
- What: the whole cloud environment as one CDK stack (EC2 box, CloudFront, instance role, two OIDC roles for CI, budget alert) and a deploy workflow that fails unless the deployed app reports healthy.
- Why: I proved a push to `main` could reach the internet with no long-lived credential anywhere before any feature depended on it.
- Where: `infra/lib/front-desk-stack.ts`, `infra/cdk.json`, `infra/compose.prod.yml`, `.github/workflows/deploy.yml`.

## 3. Contract and seed
- What: `seed(now)` produces the fictional center as data (structured data, policy sections, a staff-only section, a week of past questions forming three open gaps), and `createSandbox(now)` stores a private copy per visitor.
- Why: every date is relative to `now` so the demo never goes stale, and all data access goes through one sandbox-scoped module so one visitor can never see another's data.
- Where: `app/src/seed/`, `app/src/db/schema.ts`, `app/src/db/sandbox.ts` (`forSandbox`).

## 4. Eval harness
- What: 64 eval cases across 14 strata, a runner that does 3 trials per case, computes gated and reported metrics, and exits non-zero if any gated metric is below 1.00. Built before the answer prompt existed.
- Why: writing the cases first meant I couldn't unconsciously write cases my prompt already passes. An agent drafted each case from the PRD; I reviewed and edited every one.
- Where: `evals/cases/` (protected), `evals/src/runner.ts`, `evals/src/metrics.ts`, `.github/workflows/evals.yml`, `.github/workflows/oracle-guard.yml`.

## 5. Pipeline
- What: `POST /api/ask` runs normalize, floors, one Bedrock call with a forced reply schema, citation and grounding checks, the outcome ladder, gap filing, limits and logging. The eval runs this same `answer()` function.
- Why: the "one path" rule: what the eval measures is exactly what ships, and the model only proposes while code owns every branch.
- Where: `app/src/core/answer.ts`, `floors.ts`, `grounding.ts`, `instructions.ts`, `assemble.ts`, `gaps.ts`; `app/src/server/ask.ts`, `bedrock.ts`, `fixture.ts`.

## 6. Parent view
- What: the parent view: a Today card computed without the model, the conversation, suggested questions, and a reply rendered by outcome (answer with citation chips, degraded answer showing the handbook text, handoff with a tap-to-call link and Send to front desk, urgent with the phone link only).
- Why: parents are anxious and on a phone, so every reply shows where it came from or tells them exactly who to call.
- Where: `app/src/app/page.tsx`, `app/src/app/parent/`, `app/src/core/today.ts`, `app/src/core/copy.ts`.

## 7. Operator view
- What: the operator view: a 7-day summary, every question with its reply as the parent saw it, the open gaps, and an editor. "Answer this" on a gap opens a draft beside the parents' own phrasings; Publish creates the next snapshot and replays the gap's questions with live progress.
- Why: this is the improvement loop: an operator fixes a missing answer once and sees proof it worked, and no text is ever generated for them.
- Where: `app/src/app/operator/`, `app/src/server/replay.ts`, `app/src/app/api/publish/`, `app/src/app/api/replay/`.

## 8. Demo hardening
- What: a Try this strip that walks a stranger through the loop, Reset demo, deletion of sandboxes idle for 7 days, a nonce-based CSP on both views, a post-deploy check that the live app answers with a citation, and an emergency floor for blue lips and slow breathing.
- Why: a visitor only gets a URL, so the demo has to explain itself, survive many visitors and prove after every deploy that it still answers.
- Where: `app/src/app/demo-strip.tsx`, `app/src/app/api/reset/`, `app/src/server/idle.ts`, `app/src/proxy.ts`, `.github/scripts/check-answer.sh`.

## 9. Demo explainers
- What: on the parent view the demo controls move below the conversation, with a "How this demo works" link at the top; both views get a tap-to-open explainer of gaps; the editor's visibility choices say who sees each and warn when Staff only would leave a gap open.
- Why: a first-time visitor has to understand what they're looking at without me there, and explainers open on tap because hover doesn't exist on a phone.
- Where: `app/src/app/demo-strip.tsx`, `app/src/app/operator/editor.tsx`, `app/src/core/copy.ts`.

## 10. Write-up
- What: the one-page `README.md` (demo URL, the loop's real length, results, what wasn't built), DESIGN rewritten as the as-built design doc with results and trade-offs, and my VoiceOver pass on iOS Safari.
- Why: every number had to come from one named live eval run, and the write-up had to say what the numbers don't show.
- Where: `README.md`, `docs/DESIGN.md` sections 14 and 15.

## 11. Review and documentation fixes
- What: an independent review of the whole diff by a different model with no access to my plans found 34 issues; this pass corrected every README and DESIGN claim the code contradicted.
- Why: the write-up said the eval gate caught more than it did, and a reader should hear that from me first.
- Where: `docs/REVIEW.md`, `README.md`, `docs/DESIGN.md`.

## 12. Post-build remediation
- What: fixes for the demo-visible findings, one test-first commit each: a failed model call now fails the eval gate, urgent floors stop firing on everyday messages and catch plain emergencies they missed, a replay cut off by a deploy or Reset no longer blocks Publish, grounding reads "50 dollars" and impossible times, and a sensitive message is never filed into a gap.
- Why: I ranked the 34 findings by what a demo visitor could actually hit and fixed those first; repo and CI hardening waits.
- Where: `evals/src/metrics.ts`, `app/src/core/floors.ts`, `grounding.ts`, `gaps.ts`, `answer.ts`, `app/src/server/replay.ts`.

## Questions a reader will ask

**Why one model call, and what would make you add a second?**
Classification, citation and a short answer all fit in one forced-schema call, and everything around it is deterministic code. One call is cheaper, faster (p50 1.81 s) and has one failure mode to handle. I'd add a second when a step genuinely needs tools or multi-step retrieval, for example answering about a parent's own child, which needs an authorized data lookup first. A second call just to "check" the first would be the wrong move: code checks are deterministic, a second model call isn't.

**Why no retrieval or vector search?**
A center's whole published information is a few thousand tokens, so it all goes in context, with a cache point after it. That removes retrieval failure as a failure mode entirely: the model can't miss a section it was never shown. I'd add embeddings, in the existing Postgres, when a center's content outgrows the context or there are many documents per center.

**What happens when Bedrock is down or slow?**
- One 15 s deadline on an injected clock covers the call and all retries. A throttle is retried after 500, 1000, 2000 and 4000 ms backoffs while another attempt still fits.
- Past the deadline or on any failure, the parent gets fixed `system_error` text: "Sorry, something went wrong on our end. Please call the front desk" with the phone number. Never improvised text.
- Urgent floors never call the model, so an emergency message still gets the urgent reply with an outage.
- The honest part: the review found an outage used to pass the eval gate, because a failed call became a safe-looking handoff. Now a failed call fails `schema_valid`, so the gate goes red.

**Walk me through how a wrong fee gets caught before a parent sees it.**
Say the model writes "the late fee is $25" and cites the Late pickup section. The post-guard first drops any citation that isn't a real parent-visible section. Then `grounding.ts` extracts every price, time, date, temperature and number-with-unit from the answer, normalizes them (`$15.00` and `15 dollars` both become `$15`), and does the same over the cited sections' text. If any answer value isn't in the cited text, the answer is degraded: the parent sees the section's verbatim text instead of the generated sentence. `$25` isn't in a section that says `$15`, so it never reaches them. Limits: spelled-out numbers and weekday names aren't checked; the prompt asks for numerals.

**What does the model decide, and what does code decide?**
- The model decides: whether the information answers the question, the answer text, which sections to cite, the topic and gap label, the language, and whether a subtle message is urgent or sensitive.
- Code decides: the floors before the call, whether citations are real and parent-visible, whether every value is grounded, the final outcome (never below the floor), all handoff and urgent text, the limits, and where a question is filed.
- Rule of thumb: the model proposes, code disposes. Anything safety-critical has fixed text reviewed once.

**How do you know the eval numbers mean anything? What don't they tell you?**
- What they say: 64 cases, 3 trials each, 192 trials, no flicker. The four gated metrics (`route_safe`, `grounded`, `schema_valid`, `forbidden_clear`) were 1.00. `resolved_when_answerable` was 0.48 against 0.85.
- What they don't: they're evidence about these 64 cases only. An agent drafted them and I reviewed them, so none is held out from me. One center, English, temperature 0.
- The gates check less than their names suggest. `grounded` re-runs the pipeline's own grounding check, so it only catches drift between the two, not answers the guard misses. No case trips an urgent floor where urgent isn't expected, so floor false positives are invisible. The report records which trials failed, not each trial's outcome, so causes are inferred.
- The biggest miss: `medical_policy` at 0.00. Every symptom question ("101 temp last night, can she come in?") routed above an answer. Likely cause: the instruction "if a child may be hurt, sick, or in danger right now, set urgent" outranks "for symptom questions, give the policy". The fix narrows that line to emergencies happening now, and `route_safe` keeps it honest: if the narrower line lets a real emergency through, the gate fails. First step before tuning: log each trial's reply.

**Why one EC2 box? What changes for production inside a childcare platform?**
Every moving part fits in one head, it's always warm, and the replay can run in-process on a long-lived Node server. On serverless it would need a queue. Cost: no redundancy, and a restart mid-replay loses the replay (now shown as failed after 2 minutes). In production the portable thing is the contract (reply schema, outcome ladder, eval set): the pipeline becomes a module in the main app with background jobs for replay and gaps, RDS Postgres with row-level security, the same Bedrock model and IAM pattern, signed platform claims instead of the sandbox cookie, structured data through adapters from the platform's systems of record, handoffs into the platform's messaging, and the platform's Kubernetes instead of one box.

**What changes at 10,000 centers?**
- **Model throughput:** this account allows 10 calls a minute. At 10,000 centers you need provisioned or raised quota, per-center rate limits, and the prompt cache doing real work (each center's snapshot is a stable prefix).
- **Tenant isolation:** today one data-access module scopes every query; at scale that becomes database-enforced row-level security.
- **Content size:** some centers will outgrow the context, which is when retrieval earns its place.
- **Gaps across centers:** the same questions recur everywhere, so de-identified fleet gap counts and template sections an operator can adopt become the product.
- **Evals:** per-center golden questions with a diff on publish, so a center's edit can't silently break answers it used to give.
- **Gap filing:** label match plus Jaccard is fine for a handful of gaps; hundreds per center would push me to embeddings.

**How would you measure this in a beta with real centers?**
- **Outcome metrics:** share of questions answered without a handoff, handoffs that turned out to be answerable, operator time per week on the front desk, and time from a gap opening to its section being published.
- **Safety:** sample real replies for human review, especially handoffs and urgent; track any answer an operator corrects.
- **Fix the eval's biggest weakness:** draw new cases from real (de-identified) traffic and hold them out from whoever tunes the prompt.
- **Parent trust:** whether parents open citations, use Send to front desk, or call anyway after an answer.

**Where are the secrets?**
There are no credentials anywhere. No model API key: the instance reaches Bedrock through its instance role. CI deploys and runs evals through OIDC roles, and GitHub holds variables, not secrets; a test asserts the deploy workflow references none. The Postgres password is generated on the box at first boot into a root-only file and never leaves it. The budget alert email is a deploy-time parameter. Local AWS access is SSO only. Gitleaks runs on every commit and on full history in CI.

**What did you deliberately not build, and why?**
Spanish parity, platform identity and roles, adapters to real systems of record, handoffs into messaging and a CRM, a public website widget, answers about a parent's own child, actions with side effects, voice and SMS, PDF import, per-center golden questions, saving a staff reply to the handbook, fleet gap insights, row-level security and retrieval. Each is designed for and has a place it plugs in (PRD section 12). The scope I picked was the full trust loop for one center: a parent gets a grounded answer or an honest handoff, and an operator closes the gap and sees proof. Spanish is the one I'd do first, and it starts with safety, not translation: the floors are English-only today.
