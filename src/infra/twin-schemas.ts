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
} as const;

export type TableName = keyof typeof tableDdl;

// Changes to tables that already exist; each statement is idempotent and runs on every bootstrap.
export const migrations = [
  "ALTER TABLE calls ADD COLUMN IF NOT EXISTS eligible boolean NOT NULL DEFAULT FALSE",
  // Tables created before release_reason was part of the DDL.
  "ALTER TABLE holds ADD COLUMN IF NOT EXISTS release_reason text",
  // Two calls racing to hold one load: the index, not a read-then-insert, picks the winner.
  "CREATE UNIQUE INDEX IF NOT EXISTS holds_one_active_per_load ON holds (load_id) WHERE status <> 'released'",
] as const;

export const callRowSchema = z
  .object({
    call_id: z.string(),
    dot_number: z.string().nullable(),
    mc_number: z.string().nullable(),
    eligible: z.boolean(),
    verified: z.boolean(),
    otp_hash: z.string().nullable(),
    otp_expires_at: timestamp.nullable(),
    otp_attempts: int8,
    otp_sends: int8,
    otp_last_sent_at: timestamp.nullable(),
    created_at: timestamp,
  })
  .transform((r) => ({
    callId: r.call_id,
    dotNumber: r.dot_number,
    mcNumber: r.mc_number,
    eligible: r.eligible,
    verified: r.verified,
    otpHash: r.otp_hash,
    otpExpiresAt: r.otp_expires_at,
    otpAttempts: r.otp_attempts,
    otpSends: r.otp_sends,
    otpLastSentAt: r.otp_last_sent_at,
    createdAt: r.created_at,
  }));

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
