// The only module that touches the database. Every read and write of sandbox
// data goes through `forSandbox(sandboxId)`, and every statement it runs
// filters on, or inserts, that sandbox ID: that filter is the isolation.

import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Outcome, Reason } from '../core/types';
import { seed, type Seed } from '../seed';
import * as schema from './schema';
import { drafts, gapMembers, gaps, sandboxes, snapshots, structuredData, turns } from './schema';

// Any constant works; it only has to be the same in every process that migrates.
const MIGRATION_LOCK = 314159;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url });
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
        migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
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
        for (const table of [gapMembers, gaps, turns, snapshots, drafts, structuredData]) {
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
  };
}

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}
