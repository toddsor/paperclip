CREATE TABLE IF NOT EXISTS "org_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"sensitivity" text DEFAULT 'internal' NOT NULL,
	"propagate" boolean DEFAULT true NOT NULL,
	"source_agent_id" uuid,
	"source_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_memory_unique_key" UNIQUE NULLS NOT DISTINCT ("company_id", "scope_kind", "scope_id", "key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_memory_company_idx" ON "org_memory" ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_memory_scope_idx" ON "org_memory" ("company_id", "scope_kind", "scope_id");--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_memory_company_id_companies_id_fk') THEN
  ALTER TABLE "org_memory" ADD CONSTRAINT "org_memory_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_memory_source_agent_id_agents_id_fk') THEN
  ALTER TABLE "org_memory" ADD CONSTRAINT "org_memory_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_memory_source_issue_id_issues_id_fk') THEN
  ALTER TABLE "org_memory" ADD CONSTRAINT "org_memory_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
