import { z } from "zod";

// Shapes shared by the tower routes and the browser. The adapter's own contract lives in
// ../src/contract.ts; the parts the tower reads are mirrored here because the app cannot import across.

export const holdStatuses = ["held", "confirming", "booked", "booked_unconfirmed", "released"] as const;
export const adapterCallStages = ["verifying", "otp", "searching", "negotiating", "holding", "booked", "released", "ended"] as const;
// "connecting" is a running HappyRobot call the adapter has not heard about yet.
export const callStages = [...adapterCallStages, "connecting"] as const;
export type CallStage = (typeof callStages)[number];
export const callRisks = ["red", "amber", "green"] as const;
export const interventionKinds = ["whisper", "authorization", "listen", "takeover"] as const;
export const channels = ["voice", "text"] as const;
export type Channel = (typeof channels)[number];

// Same bounds the adapter enforces, so the tower rejects what the adapter would refuse.
export const maxAuthorizationUsd = 1_000;
export const loadIdInput = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,12}$/);
export const callIdInput = z.string().trim().min(1).max(128);
export const messageInput = z.string().trim().max(500);

const wallOffer = z.object({
  loadId: z.string(),
  round: z.number().int(),
  carrierAsk: z.number(),
  decision: z.enum(["accept", "counter", "reject"]),
  rateToSay: z.number().nullable(),
  postedRate: z.number().nullable(),
  maxBuy: z.number().nullable(),
  createdAt: z.iso.datetime(),
});

const wallHold = z.object({
  holdId: z.string(),
  loadId: z.string(),
  status: z.enum(holdStatuses),
  agreedRate: z.number(),
  postedRate: z.number().nullable(),
  maxBuy: z.number().nullable(),
  bookingRef: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const wallEvent = z.object({
  tool: z.string(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

const wallIntervention = z.object({
  kind: z.enum(interventionKinds),
  loadId: z.string().nullable(),
  amountUsd: z.number().int().nullable(),
  message: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const adapterWallCall = z.object({
  callId: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  eligible: z.boolean(),
  verified: z.boolean(),
  otp: z.object({ attempts: z.number().int(), locked: z.boolean(), expiresAt: z.iso.datetime().nullable() }),
  stage: z.enum(adapterCallStages),
  round: z.number().int().nullable(),
  risk: z.enum(callRisks),
  riskReason: z.string().nullable(),
  offers: z.array(wallOffer),
  hold: wallHold.nullable(),
  events: z.array(wallEvent),
  interventions: z.array(wallIntervention),
  createdAt: z.iso.datetime(),
});
export type AdapterWallCall = z.infer<typeof adapterWallCall>;

const tmsHealth = z.object({
  since: z.iso.datetime(),
  attempts: z.number().int(),
  retries: z.number().int(),
  faultsAbsorbed: z.number().int(),
  latencySamples: z.number().int(),
  latencyP50Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
});

export const adapterWallResponse = z.object({
  status: z.literal("ok"),
  day: z.iso.date(),
  counters: z.object({
    calls: z.number().int(),
    booked: z.number().int(),
    fraudBlocked: z.number().int(),
    dollarsGenerated: z.number(),
    marginSaved: z.number(),
  }),
  tmsHealth,
  calls: z.array(adapterWallCall),
});
export type AdapterWallResponse = z.infer<typeof adapterWallResponse>;

// A wall call as the tower serves it: the adapter row plus the live HappyRobot session, if any.
export type TowerCall = Omit<AdapterWallCall, "stage"> & {
  stage: CallStage;
  live: boolean;
  sessionId: string | null;
  channel: Channel | null;
};

export type TowerWall = Omit<AdapterWallResponse, "calls"> & {
  calls: TowerCall[];
  // True when HappyRobot could not be reached; calls then carry the adapter stage and live: false.
  liveUnavailable: boolean;
};

export type ErrorResponse = { status: string; message: string };

// Request bodies the browser sends to the tower.
export const voiceTokenBody = z.strictObject({ mode: z.enum(["listen", "takeover"]), sessionId: z.uuid() });
export type VoiceTokenBody = z.infer<typeof voiceTokenBody>;
export type VoiceTokenResponse = { url: string; token: string; roomName: string };

export const interventionBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whisper"), sessionId: z.uuid(), message: messageInput.min(1) }),
  z.strictObject({
    kind: z.literal("authorization"),
    sessionId: z.uuid(),
    loadId: loadIdInput,
    amountUsd: z.number().int().positive().max(maxAuthorizationUsd),
    message: messageInput.default(""),
  }),
]);
export type InterventionBody = z.input<typeof interventionBody>;
export type InterventionResponse = { status: "sent" | "recorded_not_sent" };

// The adapter's confirm and release answers, passed through to the browser unchanged.
export const confirmHoldResponse = z.object({
  status: z.enum([
    "booked",
    "booked_unconfirmed",
    "released",
    "in_progress",
    "already_processed",
    "tms_unavailable",
    "not_found",
    "service_unavailable",
    "invalid_request",
  ]),
  message: z.string(),
  holdId: z.string().nullable(),
  holdStatus: z.enum(holdStatuses).nullable(),
  bookingRef: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ConfirmHoldResponse = z.infer<typeof confirmHoldResponse>;

export const releaseHoldResponse = z.object({
  status: z.enum(["released", "not_releasable", "not_found", "service_unavailable", "invalid_request"]),
  message: z.string(),
  holdId: z.string().nullable(),
  holdStatus: z.enum(holdStatuses).nullable(),
  bookingRef: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ReleaseHoldResponse = z.infer<typeof releaseHoldResponse>;

export const releaseHoldBody = z.strictObject({ reason: z.string().trim().min(1).max(200).optional() });
export const idempotencyKeyInput = z.string().trim().min(1).max(128);

// Events on /api/calls/[sessionId]/stream.
export type StreamLine = { id: string; role: "agent" | "carrier"; text: string; at: string };
export type StreamTool = { name: string; at: string };
export type StreamSignal = { at: string };
export type StreamEvent =
  | { event: "line"; data: StreamLine }
  | { event: "tool"; data: StreamTool }
  | { event: "signal"; data: StreamSignal }
  | { event: "ended"; data: Record<string, never> };
