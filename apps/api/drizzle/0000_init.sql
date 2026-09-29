CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"round_id" integer NOT NULL,
	"wallet" text NOT NULL,
	"holdings_raw" bigint NOT NULL,
	"holdings_usd_micro" bigint NOT NULL,
	"tickets" integer NOT NULL,
	"mult_micro" bigint NOT NULL,
	"weighted_micro" bigint NOT NULL,
	"session_id" text,
	"lock_expires_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "entries_round_id_wallet_pk" PRIMARY KEY("round_id","wallet")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jackpot" (
	"id" integer PRIMARY KEY NOT NULL,
	"amount_raw" bigint NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"payout_id" bigint NOT NULL,
	"attempt" integer NOT NULL,
	"signature" text NOT NULL,
	"tx_base64" text NOT NULL,
	"blockhash" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"creates_ata" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"landed_slot" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"signer" text DEFAULT 'prize' NOT NULL,
	"sweep_id" bigint,
	"wallet" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"round_id" integer NOT NULL,
	"status" text NOT NULL,
	"held_reason" text,
	"tx_sig" text,
	"landed_slot" bigint,
	"ata_created" boolean,
	"rebuilds" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"error" text,
	"pump_usd_e18" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"key" text PRIMARY KEY NOT NULL,
	"value_e18" text NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prize_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"amount_raw" bigint NOT NULL,
	"ref" text,
	"slot" bigint,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round_secrets" (
	"round_id" integer PRIMARY KEY NOT NULL,
	"server_seed" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"server_seed_hash" text NOT NULL,
	"server_seed" text,
	"wallet_balance_raw" bigint,
	"outstanding_raw" bigint,
	"snapshot_slot" bigint,
	"pool_raw" bigint,
	"budget_raw" bigint,
	"ticket_budget_raw" bigint,
	"jackpot_accrual_raw" bigint,
	"jackpot_after_raw" bigint,
	"single_prize_cap_raw" bigint,
	"breaker_limit_raw" bigint,
	"payout_rate_ppm" bigint,
	"jackpot_share_ppm" bigint,
	"single_prize_cap_ppm" bigint,
	"round_breaker_ppm" bigint,
	"jackpot_odds" bigint,
	"total_weighted_micro" bigint,
	"entrant_count" integer DEFAULT 0 NOT NULL,
	"ticket_count" integer DEFAULT 0 NOT NULL,
	"pump_usd_e18" text,
	"scratchy_usd_e18" text,
	"price_state" text,
	"realized_raw" bigint DEFAULT 0 NOT NULL,
	"breaker_tripped" boolean DEFAULT false NOT NULL,
	"breaker_verified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweeps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"claimed_pump_raw" bigint DEFAULT 0 NOT NULL,
	"claimed_scratchy_raw" bigint DEFAULT 0 NOT NULL,
	"swap_in_scratchy_raw" bigint DEFAULT 0 NOT NULL,
	"swap_out_pump_raw" bigint DEFAULT 0 NOT NULL,
	"total_pump_raw" bigint DEFAULT 0 NOT NULL,
	"to_prize_raw" bigint DEFAULT 0 NOT NULL,
	"to_ops_raw" bigint DEFAULT 0 NOT NULL,
	"tx_sigs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"round_id" integer NOT NULL,
	"wallet" text NOT NULL,
	"idx" integer NOT NULL,
	"tier" smallint NOT NULL,
	"jackpot" boolean DEFAULT false NOT NULL,
	"prize_raw" bigint NOT NULL,
	"jackpot_prize_raw" bigint DEFAULT 0 NOT NULL,
	"scratched_at" timestamp with time zone,
	"void" boolean DEFAULT false NOT NULL,
	"payout_id" bigint,
	"jackpot_payout_id" bigint
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"address" text PRIMARY KEY NOT NULL,
	"x_handle" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"total_won_raw" bigint DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"ata_created_count" integer DEFAULT 0 NOT NULL,
	"eligible_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_attempts" ADD CONSTRAINT "payout_attempts_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round_secrets" ADD CONSTRAINT "round_secrets_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_kind_idx" ON "events" USING btree ("kind","at");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_attempts_sig_uq" ON "payout_attempts" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "payout_attempts_payout_idx" ON "payout_attempts" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payouts_status_idx" ON "payouts" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "payouts_wallet_idx" ON "payouts" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "payouts_round_idx" ON "payouts" USING btree ("round_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prize_ledger_kind_ref_uq" ON "prize_ledger" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "rounds_status_idx" ON "rounds" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "rounds_starts_at_uq" ON "rounds" USING btree ("starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_round_wallet_idx_uq" ON "tickets" USING btree ("round_id","wallet","idx");--> statement-breakpoint
CREATE INDEX "tickets_round_wallet_idx" ON "tickets" USING btree ("round_id","wallet");