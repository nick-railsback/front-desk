CREATE TABLE "drafts" (
	"sandbox_id" uuid PRIMARY KEY NOT NULL,
	"sections" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gap_members" (
	"sandbox_id" uuid NOT NULL,
	"gap_id" text NOT NULL,
	"turn_id" text NOT NULL,
	CONSTRAINT "gap_members_sandbox_id_gap_id_turn_id_pk" PRIMARY KEY("sandbox_id","gap_id","turn_id")
);
--> statement-breakpoint
CREATE TABLE "gaps" (
	"sandbox_id" uuid NOT NULL,
	"id" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "gaps_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"sandbox_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshots_sandbox_id_version_pk" PRIMARY KEY("sandbox_id","version")
);
--> statement-breakpoint
CREATE TABLE "structured_data" (
	"sandbox_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"sandbox_id" uuid NOT NULL,
	"id" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"answer_text" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot_version" integer NOT NULL,
	"citations" jsonb NOT NULL,
	"source" text DEFAULT 'seed' NOT NULL,
	CONSTRAINT "turns_sandbox_id_id_pk" PRIMARY KEY("sandbox_id","id")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_members" ADD CONSTRAINT "gap_members_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_members" ADD CONSTRAINT "gap_members_sandbox_id_gap_id_gaps_sandbox_id_id_fk" FOREIGN KEY ("sandbox_id","gap_id") REFERENCES "public"."gaps"("sandbox_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gap_members" ADD CONSTRAINT "gap_members_sandbox_id_turn_id_turns_sandbox_id_id_fk" FOREIGN KEY ("sandbox_id","turn_id") REFERENCES "public"."turns"("sandbox_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gaps" ADD CONSTRAINT "gaps_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structured_data" ADD CONSTRAINT "structured_data_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;