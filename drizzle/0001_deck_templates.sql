ALTER TABLE "decks" ALTER COLUMN "notify_min_due" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "enabled_templates" text[] DEFAULT '{ru_de,article,fwd,rev}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "decks" SET "notify_min_due" = 5 WHERE "notify_min_due" = 1;
