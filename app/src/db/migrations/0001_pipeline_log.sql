CREATE TABLE "usage_global" (
	"day" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_sandbox" (
	"sandbox_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "usage_sandbox_sandbox_id_bucket_pk" PRIMARY KEY("sandbox_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "proposed_outcome" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "floors_fired" jsonb;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "usage_sandbox" ADD CONSTRAINT "usage_sandbox_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;