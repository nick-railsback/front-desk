// The only module that touches the database. Every read and write of sandbox
// data goes through `forSandbox(sandboxId)`, and every statement it runs
// filters on, or inserts, that sandbox ID: that filter is the isolation.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { AnswerRecord, Outcome, Reason, Reply, Section } from '../core/types';
import { seed, type Seed } from '../seed';
import * as schema from './schema';
import { drafts, gapMembers, gaps, sandboxes, snapshots, structuredData, turns, usageGlobal, usageSandbox } from './schema';

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
          status: g.status as 'open',
          questionIds: memberRows.filter((m) => m.gapId === g.id).map((m) => m.turnId),
        })),
      };
    },

    async exists(): Promise<boolean> {
      const rows = await db().select({ id: sandboxes.id }).from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
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
  };
}

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
