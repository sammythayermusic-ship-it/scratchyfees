CREATE TABLE "activity" (
	"wallet" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	CONSTRAINT "activity_wallet_window_start_pk" PRIMARY KEY("wallet","window_start")
);
--> statement-breakpoint
CREATE INDEX "activity_window_idx" ON "activity" USING btree ("window_start");