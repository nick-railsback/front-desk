// The only module that touches the database. Every read and write of sandbox
// data goes through `forSandbox(sandboxId)`, and every statement it runs
// filters on, or inserts, that sandbox ID: that filter is the isolation. The
// module-level deletes remove whole sandboxes and read nothing.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { AnswerRecord, Outcome, Reason, Reply, Section } from '../core/types';
import { type Gap, seed, type Seed } from '../seed';
import { denverDate } from '../seed/dates';
import * as schema from './schema';
import { drafts, gapMembers, gaps, type ReplayResult, replays, sandboxes, snapshots, structuredData, turns, usageGlobal, usageSandbox } from './schema';

// Any constant works; it only has to be the same in every process that migrates.
const MIGRATION_LOCK = 314159;

let pool: pg.Pool | null = null;

// DATABASE_URL locally and in CI. In production the container gets PGHOST,
// PGUSER and PGDATABASE (read by pg itself) and POSTGRES_PASSWORD from
// /etc/frontdesk/db.env.
function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    pool = url ? new pg.Pool({ connectionString: url }) : new pg.Pool({ password: process.env.POSTGRES_PASSWORD });
    // An idle client dies when Postgres restarts or drops its connections.
    // Without a listener that error crashes the process; the pool replaces
    // the client on the next query.
    pool.on('error', (err) => console.error(`database pool: ${err.message}`));
  }
  return pool;
}

function db() {
  return drizzle(getPool(), { schema });
}

// Creates or updates the schema. Safe to run from several processes at once:
// the advisory lock lets one migrate while the others wait.
export async function migrate(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    try {
      await runMigrations(drizzle(client), {
        // The container ships migrations outside the server bundle.
        migrationsFolder: process.env.MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
      });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

export async function createSandbox(now: Date): Promise<string> {
  const [row] = await db().insert(sandboxes).values({ createdAt: now, lastSeenAt: now }).returning({ id: sandboxes.id });
  await forSandbox(row.id).write(seed(now));
  return row.id;
}

export function forSandbox(sandboxId: string) {
  return {
    // Replaces everything the sandbox holds with `content`.
    async write(content: Seed): Promise<void> {
      await db().transaction(async (tx) => {
        for (const table of [gapMembers, gaps, turns, snapshots, drafts, structuredData, usageSandbox]) {
          await tx.delete(table).where(eq(table.sandboxId, sandboxId));
        }
        await tx.insert(structuredData).values({ sandboxId, content: content.structured });
        if (content.snapshots.length > 0) {
          await tx.insert(snapshots).values(content.snapshots.map((s) => ({ sandboxId, version: s.version, sections: s.sections })));
        }
        await tx.insert(drafts).values({ sandboxId, sections: content.draft.sections });
        if (content.questions.length > 0) {
          await tx.insert(turns).values(
            content.questions.map((q) => ({
              sandboxId,
              id: q.id,
              message: q.text,
              createdAt: new Date(q.askedAt),
              answerText: q.reply.text,
              outcome: q.reply.outcome,
              reason: q.reply.reason,
              snapshotVersion: q.reply.snapshotVersion,
              citations: q.reply.citations,
            })),
          );
        }
        if (content.gaps.length > 0) {
          await tx.insert(gaps).values(content.gaps.map((g) => ({ sandboxId, id: g.id, label: g.label, status: g.status })));
        }
        const members = content.gaps.flatMap((g) => g.questionIds.map((turnId) => ({ sandboxId, gapId: g.id, turnId })));
        if (members.length > 0) await tx.insert(gapMembers).values(members);
      });
    },

    // Everything the sandbox holds, in the shape `seed(now)` returns.
    async read(): Promise<Seed> {
      const d = db();
      const [structuredRows, snapshotRows, draftRows, turnRows, gapRows, memberRows] = await Promise.all([
        d.select().from(structuredData).where(eq(structuredData.sandboxId, sandboxId)),
        d.select().from(snapshots).where(eq(snapshots.sandboxId, sandboxId)),
        d.select().from(drafts).where(eq(drafts.sandboxId, sandboxId)),
        d.select().from(turns).where(eq(turns.sandboxId, sandboxId)),
        d.select().from(gaps).where(eq(gaps.sandboxId, sandboxId)),
        d.select().from(gapMembers).where(eq(gapMembers.sandboxId, sandboxId)),
      ]);
      if (structuredRows.length === 0) throw new Error(`sandbox ${sandboxId} holds no content`);
      return {
        structured: structuredRows[0].content,
        snapshots: snapshotRows.map((s) => ({ version: s.version, sections: s.sections })),
        draft: { sections: draftRows[0]?.sections ?? [] },
        questions: turnRows.map((t) => ({
          id: t.id,
          text: t.message,
          askedAt: t.createdAt.toISOString(),
          reply: {
            text: t.answerText,
            outcome: t.outcome as Outcome,
            reason: t.reason as Reason,
            snapshotVersion: t.snapshotVersion,
            citations: t.citations,
          },
        })),
        gaps: gapRows.map((g) => ({
          id: g.id,
          label: g.label,
          status: g.status as Gap['status'],
          questionIds: memberRows.filter((m) => m.gapId === g.id).map((m) => m.turnId),
        })),
      };
    },

    // Records activity at `now`. False when the sandbox no longer exists.
    async seen(now: Date): Promise<boolean> {
      const rows = await db().update(sandboxes).set({ lastSeenAt: now }).where(eq(sandboxes.id, sandboxId)).returning({ id: sandboxes.id });
      return rows.length > 0;
    },

    async tryThisDismissed(): Promise<boolean> {
      const [row] = await db().select({ at: sandboxes.tryThisDismissedAt }).from(sandboxes).where(eq(sandboxes.id, sandboxId));
      return row?.at != null;
    },

    // False when the sandbox no longer exists.
    async dismissTryThis(now: Date): Promise<boolean> {
      const rows = await db().update(sandboxes).set({ tryThisDismissedAt: now }).where(eq(sandboxes.id, sandboxId)).returning({ id: sandboxes.id });
      return rows.length > 0;
    },

    // What answering one message needs, without the sandbox's turns: the
    // latest published snapshot, structured data, and open gap labels.
    async context(): Promise<{ snapshot: { version: number; sections: Section[] }; structured: Seed['structured']; openGapLabels: string[] }> {
      const d = db();
      const [snapshotRows, structuredRows, gapRows] = await Promise.all([
        d.select().from(snapshots).where(eq(snapshots.sandboxId, sandboxId)).orderBy(desc(snapshots.version)).limit(1),
        d.select().from(structuredData).where(eq(structuredData.sandboxId, sandboxId)),
        d.select({ label: gaps.label }).from(gaps).where(and(eq(gaps.sandboxId, sandboxId), eq(gaps.status, 'open'))),
      ]);
      if (snapshotRows.length === 0 || structuredRows.length === 0) throw new Error(`sandbox ${sandboxId} holds no published snapshot`);
      return {
        snapshot: { version: snapshotRows[0].version, sections: snapshotRows[0].sections },
        structured: structuredRows[0].content,
        openGapLabels: gapRows.map((g) => g.label),
      };
    },

    // Counts one message in its minute and its day, and returns both counts.
    async countMessage(minuteKey: string, dayKey: string): Promise<{ minute: number; day: number }> {
      const rows = await db()
        .insert(usageSandbox)
        .values([
          { sandboxId, bucket: minuteKey, count: 1 },
          { sandboxId, bucket: dayKey, count: 1 },
        ])
        .onConflictDoUpdate({ target: [usageSandbox.sandboxId, usageSandbox.bucket], set: { count: sql`${usageSandbox.count} + 1` } })
        .returning({ bucket: usageSandbox.bucket, count: usageSandbox.count });
      const count = (bucket: string) => rows.find((r) => r.bucket === bucket)?.count ?? 0;
      return { minute: count(minuteKey), day: count(dayKey) };
    },

    // Stores a reply the pipeline produced, and returns its turn ID.
    async storeReply(message: string, askedAt: Date, record: AnswerRecord): Promise<string> {
      const id = `live-${randomUUID()}`;
      const { reply } = record;
      await db()
        .insert(turns)
        .values({
          sandboxId,
          id,
          message,
          createdAt: askedAt,
          answerText: reply.text,
          outcome: reply.outcome,
          reason: reply.reason,
          snapshotVersion: reply.snapshotVersion,
          citations: reply.citations,
          source: 'live',
          proposedOutcome: record.proposedOutcome,
          floorsFired: record.floorsFired,
          language: record.language,
          topic: record.topic,
          latencyMs: Math.round(record.latencyMs),
          inputTokens: record.usage.input,
          cachedInputTokens: record.usage.cachedInput,
          outputTokens: record.usage.output,
        });
      return id;
    },

    // Files a stored reply into the open gap with this label, opening one if
    // none exists.
    async fileIntoGap(turnId: string, label: string): Promise<void> {
      await db().transaction(async (tx) => {
        const [open] = await tx
          .select({ id: gaps.id })
          .from(gaps)
          .where(and(eq(gaps.sandboxId, sandboxId), eq(gaps.status, 'open'), eq(gaps.label, label)))
          .limit(1);
        const gapId = open?.id ?? `gap-${randomUUID()}`;
        if (!open) await tx.insert(gaps).values({ sandboxId, id: gapId, label, status: 'open' });
        await tx.insert(gapMembers).values({ sandboxId, gapId, turnId });
      });
    },

    // Marks a stored reply as sent to the front desk. True only when this call
    // set the mark: a reply already sent, urgent, seeded, or not in this
    // sandbox is left unchanged.
    async markSent(turnId: string, now: Date): Promise<boolean> {
      const rows = await db()
        .update(turns)
        .set({ sentToFrontDesk: now })
        .where(
          and(
            eq(turns.sandboxId, sandboxId),
            eq(turns.id, turnId),
            eq(turns.source, 'live'),
            ne(turns.outcome, 'urgent'),
            isNull(turns.sentToFrontDesk),
          ),
        )
        .returning({ id: turns.id });
      return rows.length > 0;
    },

    // The replies the pipeline stored, without the seeded history.
    async replies(): Promise<StoredReply[]> {
      const rows = await db()
        .select()
        .from(turns)
        .where(and(eq(turns.sandboxId, sandboxId), eq(turns.source, 'live')));
      return rows.map((t) => ({
        id: t.id,
        message: t.message,
        askedAt: t.createdAt.toISOString(),
        reply: { text: t.answerText, outcome: t.outcome as Outcome, reason: t.reason as Reason, snapshotVersion: t.snapshotVersion, citations: t.citations },
        proposedOutcome: t.proposedOutcome as Outcome | null,
        floors: t.floorsFired ?? [],
        language: t.language,
        topic: t.topic,
        latencyMs: t.latencyMs ?? 0,
        usage: { input: t.inputTokens ?? 0, cachedInput: t.cachedInputTokens ?? 0, output: t.outputTokens ?? 0 },
      }));
    },

    // Every question the sandbox holds, seeded and live, newest first.
    // Replayed replies are never turns, so they are never here.
    async questions(): Promise<OperatorQuestion[]> {
      const rows = await db().select().from(turns).where(eq(turns.sandboxId, sandboxId)).orderBy(desc(turns.createdAt));
      return rows.map((t) => ({
        id: t.id,
        message: t.message,
        askedAt: t.createdAt.toISOString(),
        reply: { text: t.answerText, outcome: t.outcome as Outcome, reason: t.reason as Reason, snapshotVersion: t.snapshotVersion, citations: t.citations },
        sentToFrontDesk: t.sentToFrontDesk !== null,
      }));
    },

    // Every gap with its member questions, newest first.
    async gapsWithQuestions(): Promise<OperatorGap[]> {
      const d = db();
      const [gapRows, memberRows] = await Promise.all([
        d.select().from(gaps).where(eq(gaps.sandboxId, sandboxId)),
        d
          .select({ gapId: gapMembers.gapId, id: turns.id, message: turns.message, createdAt: turns.createdAt })
          .from(gapMembers)
          .innerJoin(turns, and(eq(turns.sandboxId, gapMembers.sandboxId), eq(turns.id, gapMembers.turnId)))
          .where(eq(gapMembers.sandboxId, sandboxId))
          .orderBy(desc(turns.createdAt)),
      ]);
      return gapRows.map((g) => ({
        id: g.id,
        label: g.label,
        status: g.status as Gap['status'],
        questions: memberRows.filter((m) => m.gapId === g.id).map((m) => ({ id: m.id, message: m.message, askedAt: m.createdAt.toISOString() })),
      }));
    },

    // Every published snapshot, oldest first: a reply's citations are drawn
    // from the version it recorded.
    async snapshots(): Promise<{ version: number; sections: Section[]; publishedAt: string }[]> {
      const rows = await db().select().from(snapshots).where(eq(snapshots.sandboxId, sandboxId)).orderBy(snapshots.version);
      return rows.map((s) => ({ version: s.version, sections: s.sections, publishedAt: s.publishedAt.toISOString() }));
    },

    async draft(): Promise<Section[]> {
      const rows = await db().select({ sections: drafts.sections }).from(drafts).where(eq(drafts.sandboxId, sandboxId));
      if (rows.length === 0) throw new Error(`sandbox ${sandboxId} holds no draft`);
      return rows[0].sections;
    },

    // Puts one section into the draft. A null ID adds a new section dated
    // `today`; any other ID replaces that section's title, visibility and
    // text, keeping its date until a publish restamps it. Null when the ID
    // names no draft section.
    async saveSection(input: Omit<Section, 'updatedOn' | 'id'> & { id: string | null }, today: string): Promise<Section | null> {
      return db().transaction(async (tx) => {
        const [row] = await tx.select({ sections: drafts.sections }).from(drafts).where(eq(drafts.sandboxId, sandboxId)).for('update');
        if (!row) throw new Error(`sandbox ${sandboxId} holds no draft`);
        const old = input.id === null ? null : row.sections.find((s) => s.id === input.id);
        if (old === undefined) return null;
        const section: Section = { ...input, id: old?.id ?? randomUUID(), updatedOn: old?.updatedOn ?? today };
        const sections = old ? row.sections.map((s) => (s === old ? section : s)) : [...row.sections, section];
        await tx.update(drafts).set({ sections, updatedAt: new Date() }).where(eq(drafts.sandboxId, sandboxId));
        return section;
      });
    },

    // Publishes the draft as snapshot N+1 and opens its replay, in one
    // transaction, so a failure creates neither. A section that is new or
    // differs from N's copy carries today's Denver date; every other section
    // keeps N's. The draft takes the same dates, so it matches N+1 exactly.
    async publish(now: Date): Promise<{ version: number; replayId: string; total: number }> {
      return db().transaction(async (tx) => {
        const [draftRow] = await tx.select({ sections: drafts.sections }).from(drafts).where(eq(drafts.sandboxId, sandboxId)).for('update');
        const [latest] = await tx.select().from(snapshots).where(eq(snapshots.sandboxId, sandboxId)).orderBy(desc(snapshots.version)).limit(1);
        if (!draftRow || !latest) throw new Error(`sandbox ${sandboxId} holds no draft or snapshot`);
        const today = denverDate(now);
        const sections = draftRow.sections.map((s) => {
          const old = latest.sections.find((o) => o.id === s.id);
          const same = old && old.title === s.title && old.visibility === s.visibility && old.text === s.text;
          return { ...s, updatedOn: same ? old.updatedOn : today };
        });
        const version = latest.version + 1;
        await tx.insert(snapshots).values({ sandboxId, version, sections, publishedAt: now });
        await tx.update(drafts).set({ sections, updatedAt: now }).where(eq(drafts.sandboxId, sandboxId));
        const counts = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(gapMembers)
          .innerJoin(gaps, and(eq(gaps.sandboxId, gapMembers.sandboxId), eq(gaps.id, gapMembers.gapId)))
          .where(and(eq(gapMembers.sandboxId, sandboxId), eq(gaps.status, 'open')))
          .groupBy(gaps.id);
        const total = counts.reduce((sum, c) => sum + Math.min(REPLAY_PER_GAP, c.count), 0);
        const [replay] = await tx
          .insert(replays)
          .values({ sandboxId, snapshotVersion: version, status: total > 0 ? 'running' : 'done', completed: 0, total, results: [], createdAt: now })
          .returning({ id: replays.id });
        return { version, replayId: replay.id, total };
      });
    },

    // Each open gap with its most recent questions, the ones a replay re-runs.
    async replayQuestions(): Promise<{ id: string; label: string; messages: string[] }[]> {
      const open = (await this.gapsWithQuestions()).filter((g) => g.status === 'open');
      return open.map((g) => ({ id: g.id, label: g.label, messages: g.questions.slice(0, REPLAY_PER_GAP).map((q) => q.message) }));
    },

    async recordReplayProgress(replayId: string, completed: number): Promise<void> {
      await db()
        .update(replays)
        .set({ completed })
        .where(and(eq(replays.sandboxId, sandboxId), eq(replays.id, replayId)));
    },

    // Ends a replay with each gap's result, and resolves the gaps it
    // resolved, in one transaction.
    async finishReplay(replayId: string, results: ReplayResult[]): Promise<void> {
      const replayed = results.reduce((sum, r) => sum + r.replayed, 0);
      const resolved = results.filter((r) => r.resolved).map((r) => r.gapId);
      await db().transaction(async (tx) => {
        await tx
          .update(replays)
          .set({ status: 'done', completed: replayed, total: replayed, results })
          .where(and(eq(replays.sandboxId, sandboxId), eq(replays.id, replayId)));
        if (resolved.length > 0) {
          await tx
            .update(gaps)
            .set({ status: 'resolved' })
            .where(and(eq(gaps.sandboxId, sandboxId), inArray(gaps.id, resolved)));
        }
      });
    },

    async failReplay(replayId: string): Promise<void> {
      await db()
        .update(replays)
        .set({ status: 'failed' })
        .where(and(eq(replays.sandboxId, sandboxId), eq(replays.id, replayId)));
    },

    // The sandbox's latest replay, or null before its first publish.
    async latestReplay(): Promise<Replay | null> {
      const [row] = await db().select().from(replays).where(eq(replays.sandboxId, sandboxId)).orderBy(desc(replays.snapshotVersion)).limit(1);
      return row ? { status: row.status as Replay['status'], completed: row.completed, total: row.total, results: row.results } : null;
    },
  };
}

// A gap's questions a replay re-runs: its most recent 20 (PRD O10).
const REPLAY_PER_GAP = 20;

export type OperatorQuestion = { id: string; message: string; askedAt: string; reply: Reply; sentToFrontDesk: boolean };

export type OperatorGap = { id: string; label: string; status: Gap['status']; questions: { id: string; message: string; askedAt: string }[] };

export type Replay = { status: 'running' | 'done' | 'failed'; completed: number; total: number; results: ReplayResult[] };

export type StoredReply = {
  id: string;
  message: string;
  askedAt: string;
  reply: Reply;
  proposedOutcome: Outcome | null;
  floors: string[];
  language: string | null;
  topic: string | null;
  latencyMs: number;
  usage: AnswerRecord['usage'];
};

// Deletes the sandbox. Every other table's rows go with it through their
// ON DELETE CASCADE foreign keys.
export async function deleteSandbox(sandboxId: string): Promise<void> {
  await db().delete(sandboxes).where(eq(sandboxes.id, sandboxId));
}

// Deletes every sandbox idle for more than 7 days before `now` (PRD D7), with
// all its data, and returns how many went.
export async function deleteIdleSandboxes(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - IDLE_DAYS * 86_400_000);
  const rows = await db().delete(sandboxes).where(lt(sandboxes.lastSeenAt, cutoff)).returning({ id: sandboxes.id });
  return rows.length;
}

const IDLE_DAYS = 7;

// Reserves one of the day's model calls across every sandbox. False when the
// day's cap is reached. One statement, so concurrent messages cannot both take
// the last call.
export async function reserveModelCall(day: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const rows = await db()
    .insert(usageGlobal)
    .values({ day, count: 1 })
    .onConflictDoUpdate({ target: usageGlobal.day, set: { count: sql`${usageGlobal.count} + 1` }, setWhere: sql`${usageGlobal.count} < ${cap}` })
    .returning({ count: usageGlobal.count });
  return rows.length > 0;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
