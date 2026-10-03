// Tables. Every table that holds sandbox data has `sandbox_id` in its primary
// key: content IDs come from the seed and repeat across sandboxes.

import { foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Citation, Section } from '../core/types';
import type { Seed } from '../seed';

export const sandboxes = pgTable('sandboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
});

const sandboxId = () =>
  uuid('sandbox_id')
    .notNull()
    .references(() => sandboxes.id, { onDelete: 'cascade' });

// Center details, programs, fee, calendar, menus, and alerts as one document:
// only sections are ever edited, and nothing queries inside it.
export const structuredData = pgTable('structured_data', {
  sandboxId: sandboxId().primaryKey(),
  content: jsonb('content').$type<Seed['structured']>().notNull(),
});

export const snapshots = pgTable(
  'snapshots',
  {
    sandboxId: sandboxId(),
    version: integer('version').notNull(),
    sections: jsonb('sections').$type<Section[]>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.version] })],
);

export const drafts = pgTable('drafts', {
  sandboxId: sandboxId().primaryKey(),
  sections: jsonb('sections').$type<Section[]>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// One parent message and its reply.
export const turns = pgTable(
  'turns',
  {
    sandboxId: sandboxId(),
    id: text('id').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    answerText: text('answer_text').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    snapshotVersion: integer('snapshot_version').notNull(),
    citations: jsonb('citations').$type<Citation[]>().notNull(),
    source: text('source').notNull().default('seed'),
    // The T13 log fields. Null on seeded history, which was never answered live.
    proposedOutcome: text('proposed_outcome'),
    floorsFired: jsonb('floors_fired').$type<string[]>(),
    language: text('language'),
    topic: text('topic'),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    outputTokens: integer('output_tokens'),
    // When the parent sent this reply to the front desk; chunk 07's Questions list reads it.
    sentToFrontDesk: timestamp('sent_to_front_desk', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

export const gaps = pgTable(
  'gaps',
  {
    sandboxId: sandboxId(),
    id: text('id').notNull(),
    label: text('label').notNull(),
    status: text('status').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.id] })],
);

export const gapMembers = pgTable(
  'gap_members',
  {
    sandboxId: sandboxId(),
    gapId: text('gap_id').notNull(),
    turnId: text('turn_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.gapId, t.turnId] }),
    foreignKey({ columns: [t.sandboxId, t.gapId], foreignColumns: [gaps.sandboxId, gaps.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.sandboxId, t.turnId], foreignColumns: [turns.sandboxId, turns.id] }).onDelete('cascade'),
  ],
);

// Messages per sandbox in one bucket: a Denver minute (`m:2026-11-04T10:15`)
// or a Denver day (`d:2026-11-04`).
export const usageSandbox = pgTable(
  'usage_sandbox',
  {
    sandboxId: sandboxId(),
    bucket: text('bucket').notNull(),
    count: integer('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sandboxId, t.bucket] })],
);

// Model calls across every sandbox on one Denver day.
export const usageGlobal = pgTable('usage_global', {
  day: text('day').primaryKey(),
  count: integer('count').notNull(),
});
