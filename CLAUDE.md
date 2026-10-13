# Front Desk

Mobile-first AI front desk prototype for one fictional childcare center: parent chat plus operator console.
- Contract: `docs/PRD.md`
- Design: `docs/DESIGN.md`
- How it was built: `docs/WALKTHROUGH.md`; the post-build review: `docs/REVIEW.md`

## Commands

- `pnpm install`
- `docker compose -f infra/compose.dev.yml up -d db`: local Postgres
- `pnpm dev`: runs with `MODEL_MODE=fixture` by default
- `pnpm test`, `pnpm test:e2e`
- `pnpm eval`: needs an AWS profile with Bedrock access; live model calls

## Standing rules

Most of these are also enforced by deny rules, hooks, or CI. This is the teaching half.

1. Feature work follows the [feature-chunker](https://github.com/nick-railsback/feature-chunker) lifecycle: spec, blind-written tests, plan gate, implement, verify, retro. Propose git actions (branch, commit, push) for approval; never run one without it.
2. Never deploy. No `cdk deploy`, no `aws ssm send-command`.
3. Never edit `evals/cases/`. Changes there need a human and the `oracle-change` label.
4. `app/src/core/` is pure:
   - no `Date.now()`, no network, no DB;
   - the clock and the model are injected.
5. Every user-facing string lives in `app/src/core/copy.ts`.
6. Dependencies come from the allowlist in `docs/DESIGN.md` section 11. Anything else needs a reason at the plan gate.
7. Data is fictional only:
   - phone numbers 555-0100 to 555-0199;
   - `.example` domains.
8. Use the PRD glossary nouns (snapshot, section, reply, outcome, reason, floor, citation, gap, replay, sandbox) in code, DB, UI, and docs.
9. No em-dashes in prose, comments, or UI copy.
10. Prefer the obvious implementation. No generic frameworks, plugin systems, or abstractions with one caller.
