import { z } from "zod";

// Table DDL and row parsers. Twin returns int8 as strings and timestamps as ISO strings,
// so every read goes through these schemas and hands camelCase objects to the domain.

const int8 = z.coerce.number().int();
const timestamp = z.coerce.date();

export const tableDdl = {
  calls: `CREATE TABLE IF NOT EXISTS calls (
    call_id text PRIMARY KEY,
    dot_number text,
    mc_number text,
    eligible boolean NOT NULL DEFAULT FALSE,
    verified boolean NOT NULL DEFAULT FALSE,
    otp_hash text,
    otp_expires_at timestamp,
    otp_attempts int8 NOT NULL DEFAULT 0,
    otp_sends int8 NOT NULL DEFAULT 0,
    otp_last_sent_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  offers: `CREATE TABLE IF NOT EXISTS offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL,
    load_id text NOT NULL,
    round int8 NOT NULL CHECK (round >= 1),
    carrier_ask int8 NOT NULL CHECK (carrier_ask > 0),
    decision text NOT NULL CHECK (decision IN ('accept', 'counter', 'reject')),
    rate_to_say int8,
    created_at timestamp NOT NULL DEFAULT now(),
    UNIQUE (call_id, load_id, round)
  )`,
  holds: `CREATE TABLE IF NOT EXISTS holds (
    hold_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL,
    load_id text NOT NULL,
    mc_number text,
    agreed_rate int8 NOT NULL CHECK (agreed_rate > 0),
    status text NOT NULL DEFAULT 'held'
      CHECK (status IN ('held', 'confirming', 'booked', 'booked_unconfirmed', 'released')),
    booking_ref text,
    idempotency_key text UNIQUE,
    release_reason text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  )`,
  // One row per named agent tool call (request_human writes its own before answering); the operator wall reads it.
  call_events: `CREATE TABLE IF NOT EXISTS call_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL,
    tool text NOT NULL,
    summary text,
    status text,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  // Every operator action on a live call. An authorization raises the counter on one load,
  // never past that load's max buy (see evaluateOffer).
  interventions: `CREATE TABLE IF NOT EXISTS interventions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('whisper', 'authorization', 'listen', 'takeover')),
    load_id text,
    amount_usd int8 CHECK (amount_usd > 0),
    message text,
    created_at timestamp NOT NULL DEFAULT now(),
    CHECK ((kind = 'authorization') = (load_id IS NOT NULL AND amount_usd IS NOT NULL))
  )`,
  // Operator switches. 'autonomy' is 'human' (the default: a rep confirms every hold) or
  // 'autonomous' (create_hold books right away, under the same max buy guard).
  settings: `CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamp NOT NULL DEFAULT now()
  )`,
  // One row per search that reached the board, as the carrier asked it (NULL equipment means any),
  // so the demand radar can show lanes carriers ask for that the board does not cover.
  load_searches: `CREATE TABLE IF NOT EXISTS load_searches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL,
    origin_city text,
    origin_state text,
    origin_zip text,
    destination_city text,
    destination_state text,
    destination_zip text,
    equipment text,
    pickup_date text,
    results int8 NOT NULL,
    dropped_impossible int8 NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  // One truck per call that agreed to be contacted: where and when it frees up (NULL equipment means any).
  // notified_* is set once a matching load is sent, so a carrier is never told twice.
  truck_capacity: `CREATE TABLE IF NOT EXISTS truck_capacity (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id text NOT NULL UNIQUE,
    mc_number text NOT NULL,
    city text NOT NULL,
    state text NOT NULL,
    equipment text,
    free_date date NOT NULL,
    preferred_destination_state text,
    notified_load_id text,
    notified_at timestamp,
    created_at timestamp NOT NULL DEFAULT now()
  )`,
  // A stored conversation, for calls that have no HappyRobot session to stream (the demo dataset).
  // role 'tool' carries the tool name as text; the tower replays the rows like a session stream.
  call_transcripts: `CREATE TABLE IF NOT EXISTS call_transcripts (
    call_id text NOT NULL,
    seq int8 NOT NULL,
    role text NOT NULL CHECK (role IN ('agent', 'carrier', 'tool', 'signal')),
    text text NOT NULL,
    at timestamp NOT NULL,
    PRIMARY KEY (call_id, seq)
  )`,
} as const;

// Changes to tables that already exist; each statement is idempotent and runs on every bootstrap.
export const migrations = [
  // Two calls racing to hold one load: the index, not a read-then-insert, picks the winner.
  "CREATE UNIQUE INDEX IF NOT EXISTS holds_one_active_per_load ON holds (load_id) WHERE status <> 'released'",
  // The load's posted rate and max buy at decision time, for the operator only; never sent to the agent.
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS posted_rate int8",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS max_buy int8",
  "ALTER TABLE holds ADD COLUMN IF NOT EXISTS posted_rate int8",
  "ALTER TABLE holds ADD COLUMN IF NOT EXISTS max_buy int8",
  // The load's lane at decision time, so the operator map needs no TMS read.
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS origin_city text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS origin_state text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS origin_zip text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS destination_city text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS destination_state text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS destination_zip text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS equipment text",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS miles int8",
  "ALTER TABLE offers ADD COLUMN IF NOT EXISTS pickup_at text",
  "CREATE INDEX IF NOT EXISTS call_events_by_call ON call_events (call_id, created_at)",
  "CREATE INDEX IF NOT EXISTS interventions_by_call ON interventions (call_id, created_at)",
  "CREATE INDEX IF NOT EXISTS load_searches_by_call ON load_searches (call_id, created_at)",
  // The FMCSA name at verification, so the inbox can name a carrier without calling FMCSA again.
  "ALTER TABLE calls ADD COLUMN IF NOT EXISTS carrier_name text",
  // Diesel, tolls, net and legal ETA at the agreed rate, as estimated when the hold was placed; NULL when no estimate was made.
  "ALTER TABLE holds ADD COLUMN IF NOT EXISTS trip jsonb",
  // Where this call's code went, so the hold notice reaches the contact that passed verification.
  "ALTER TABLE calls ADD COLUMN IF NOT EXISTS otp_channel text",
  "ALTER TABLE calls ADD COLUMN IF NOT EXISTS otp_destination text",
] as const;

export const autonomyModes = ["human", "autonomous"] as const;
export type AutonomyMode = (typeof autonomyModes)[number];

export const holdStatuses = ["held", "confirming", "booked", "booked_unconfirmed", "released"] as const;

export const holdRowSchema = z
  .object({
    hold_id: z.string(),
    call_id: z.string(),
    load_id: z.string(),
    mc_number: z.string().nullable(),
    agreed_rate: int8,
    status: z.enum(holdStatuses),
    booking_ref: z.string().nullable(),
    idempotency_key: z.string().nullable(),
    // A replayed confirm must return the same reason, so it is stored with the hold.
    release_reason: z.string().nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .transform((r) => ({
    holdId: r.hold_id,
    callId: r.call_id,
    loadId: r.load_id,
    mcNumber: r.mc_number,
    agreedRate: r.agreed_rate,
    status: r.status,
    bookingRef: r.booking_ref,
    idempotencyKey: r.idempotency_key,
    releaseReason: r.release_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
export type HoldRow = z.output<typeof holdRowSchema>;
