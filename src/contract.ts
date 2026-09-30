import { z } from "zod";
import { maxAuthorizationUsd, otpDigits } from "./constants.ts";
import { callRisks, callStages } from "./domain/call-stage.ts";
import { tripStatuses } from "./domain/trip.ts";
import { feasibilities } from "./domain/trip-estimate.ts";
import { cityInput, equipmentInput, loadIdInput, stateInput, zipInput } from "./infra/tms/codec.ts";
import { autonomyModes, holdStatuses } from "./infra/twin-schemas.ts";

// Request and response schemas for the agent and operator APIs.

// Callers say "MC 123456" or "DOT# 0123456"; stored and queried as bare digits without leading zeros.
const carrierIdentifier = (prefix: "MC" | "DOT") =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(new RegExp(`^${prefix}\\s*[#:-]?\\s*`, "i"), ""))
    .pipe(z.string().regex(/^\d{1,8}$/, `${prefix} number must be 1 to 8 digits`))
    .transform((digits) => digits.replace(/^0+(?=\d)/, ""));

// The agent's webhooks send every tool parameter as a string, and "" when the caller gave none.
const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalField = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

// Whole US dollars, sent as a number by tests and as a digit string by the agent.
const wholeDollars = z.preprocess(
  (value) => (typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
  z.number().int().positive().max(1_000_000),
);

export const verifyCarrierBody = z
  .object({
    callId: z.string().trim().min(1).max(128),
    mcNumber: optionalField(carrierIdentifier("MC")),
    dotNumber: optionalField(carrierIdentifier("DOT")),
  })
  .refine((body) => (body.mcNumber === undefined) !== (body.dotNumber === undefined), {
    message: "Provide exactly one of mcNumber or dotNumber",
  });
export type VerifyCarrierBody = z.output<typeof verifyCarrierBody>;

export const verifyCarrierResponse = z.object({
  status: z.enum(["ok", "not_eligible", "needs_review", "verification_unavailable", "invalid_request"]),
  message: z.string(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  carrierName: z.string().nullable(),
  dotNumber: z.string().nullable(),
  mcNumber: z.string().nullable(),
  maskedContact: z.object({ email: z.string().optional(), phone: z.string().optional() }),
  riskFlags: z.array(z.enum(["contact_changed_recently", "no_contact_on_file"])),
});
export type VerifyCarrierResponse = z.infer<typeof verifyCarrierResponse>;

const callId = z.string().trim().min(1).max(128);

// "Any", "anything" or "all" means no equipment filter, the same as leaving it blank.
const anyEquipment = /^\s*(any|anything|all)\s*$/i;
const optionalEquipment = z.preprocess(
  (value) => (typeof value === "string" && anyEquipment.test(value) ? undefined : blankToUndefined(value)),
  equipmentInput.optional(),
);

// Flat fields because each is one tool parameter; the route reads origin/destination objects.
// The TMS codec's own inputs, so a bad filter is a 200 invalid_request, not a thrown error.
export const searchLoadsBody = z
  .object({
    callId,
    originCity: optionalField(cityInput),
    originState: optionalField(stateInput),
    originZip: optionalField(zipInput),
    destinationCity: optionalField(cityInput),
    destinationState: optionalField(stateInput),
    destinationZip: optionalField(zipInput),
    equipmentType: optionalEquipment,
    pickupDate: optionalField(z.iso.date()),
  })
  .refine((b) => b.originCity !== undefined || b.originState !== undefined || b.originZip !== undefined, {
    message: "Provide an origin city, state or zip",
  })
  .transform(({ originCity, originState, originZip, destinationCity, destinationState, destinationZip, ...rest }) => {
    const hasDestination = destinationCity !== undefined || destinationState !== undefined || destinationZip !== undefined;
    return {
      ...rest,
      origin: { city: originCity, state: originState, zip: originZip },
      destination: hasDestination ? { city: destinationCity, state: destinationState, zip: destinationZip } : undefined,
    };
  });
export type SearchLoadsBody = z.output<typeof searchLoadsBody>;

// The max buy is never part of this shape, so the serializer can never emit it.
export const pitchedLoad = z.object({
  loadId: z.string(),
  origin: z.string(),
  destination: z.string(),
  pickupDateTime: z.string(),
  deliveryDateTime: z.string(),
  equipmentType: z.string(),
  loadboardRate: z.number(),
  miles: z.number(),
  weight: z.number(),
  commodity: z.string(),
  pieces: z.number(),
  dims: z.string(),
  notes: z.string(),
  // Whether one driver can legally make the window at the posted rate; null when no estimate was made.
  feasibility: z.enum(feasibilities).nullable(),
});
export type PitchedLoad = z.infer<typeof pitchedLoad>;

export const searchLoadsResponse = z.object({
  status: z.enum(["ok", "no_loads", "not_verified", "tms_unavailable", "service_unavailable", "invalid_request"]),
  message: z.string(),
  loads: z.array(pitchedLoad),
});
export type SearchLoadsResponse = z.infer<typeof searchLoadsResponse>;

export const evaluateOfferBody = z.object({
  callId,
  loadId: loadIdInput,
  carrierAsk: wholeDollars,
});
export type EvaluateOfferBody = z.output<typeof evaluateOfferBody>;

export const evaluateOfferResponse = z.object({
  status: z.enum([
    "ok",
    "not_verified",
    "load_unavailable",
    "tms_unavailable",
    "service_unavailable",
    "retry",
    "invalid_request",
  ]),
  message: z.string(),
  decision: z.enum(["accept", "counter", "reject"]).nullable(),
  rateToSay: z.number().nullable(),
  round: z.number().nullable(),
  isFinalRound: z.boolean(),
});
export type EvaluateOfferResponse = z.infer<typeof evaluateOfferResponse>;

export const tripEstimateBody = z.object({ callId, loadId: loadIdInput });
export type TripEstimateBody = z.output<typeof tripEstimateBody>;

// What the carrier keeps at a rate after diesel and tolls. Stored on the hold as is; never carries the max buy.
export const tripSnapshot = z.object({
  rate: z.number().int(),
  dieselUsd: z.number().int(),
  tollsUsd: z.number().int(),
  carrierNetUsd: z.number().int(),
  feasibility: z.enum(feasibilities),
  legalEtaAt: z.iso.datetime(),
  netPerHour: z.number().int(),
});
export type TripSnapshot = z.infer<typeof tripSnapshot>;

export const tripEstimateResponse = z.object({
  status: z.enum([
    "ok",
    "not_verified",
    "load_unavailable",
    "tms_unavailable",
    "estimate_unavailable",
    "service_unavailable",
    "invalid_request",
  ]),
  message: z.string(),
  rate: tripSnapshot.shape.rate.nullable(),
  dieselUsd: tripSnapshot.shape.dieselUsd.nullable(),
  tollsUsd: tripSnapshot.shape.tollsUsd.nullable(),
  carrierNetUsd: tripSnapshot.shape.carrierNetUsd.nullable(),
  feasibility: tripSnapshot.shape.feasibility.nullable(),
  legalEtaAt: tripSnapshot.shape.legalEtaAt.nullable(),
  netPerHour: tripSnapshot.shape.netPerHour.nullable(),
});
export type TripEstimateResponse = z.infer<typeof tripEstimateResponse>;

// Callers and the agent name the channel loosely: "Text", "e-mail", "SMS message".
const channelAliases = new Map([
  ["text", "sms"],
  ["sms message", "sms"],
  ["txt", "sms"],
  ["e-mail", "email"],
  ["mail", "email"],
]);
const otpChannel = z
  .string()
  .transform((value) => value.trim().toLowerCase().replace(/\s+/g, " "))
  .transform((value) => channelAliases.get(value) ?? value)
  .pipe(z.enum(["email", "sms"]));

export const sendOtpBody = z.object({ callId, channel: otpChannel });
export type SendOtpBody = z.output<typeof sendOtpBody>;

export const sendOtpResponse = z.object({
  status: z.enum([
    "ok",
    "not_eligible",
    "too_many_requests",
    "no_contact_on_file",
    "channel_unavailable",
    "delivery_unavailable",
    "service_unavailable",
    "invalid_request",
  ]),
  message: z.string(),
  sent: z.boolean(),
  maskedDestination: z.string().nullable(),
  expiresInSeconds: z.number().int().nullable(),
});
export type SendOtpResponse = z.infer<typeof sendOtpResponse>;

// A code read aloud often arrives as "123 456" or "123-456".
const otpCode = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(new RegExp(`^\\d{${otpDigits}}$`), `code must be ${otpDigits} digits`));

export const checkOtpBody = z.object({ callId, code: otpCode });
export type CheckOtpBody = z.output<typeof checkOtpBody>;

export const checkOtpResponse = z.object({
  status: z.enum(["ok", "wrong_code", "expired", "locked", "no_active_code", "service_unavailable", "invalid_request"]),
  message: z.string(),
  verified: z.boolean(),
  attemptsLeft: z.number().int().nullable(),
});
export type CheckOtpResponse = z.infer<typeof checkOtpResponse>;

export const createHoldBody = z.object({
  callId,
  loadId: loadIdInput,
  agreedRate: wholeDollars,
});
export type CreateHoldBody = z.output<typeof createHoldBody>;

export const createHoldResponse = z.object({
  status: z.enum([
    "ok",
    "not_verified",
    "no_agreement",
    "mc_number_required",
    "load_unavailable",
    "load_on_hold",
    "tms_unavailable",
    "service_unavailable",
    "invalid_request",
  ]),
  message: z.string(),
  holdId: z.string().nullable(),
  holdStatus: z.enum(holdStatuses).nullable(),
});
export type CreateHoldResponse = z.infer<typeof createHoldResponse>;

export const confirmHoldParams = z.object({ holdId: z.uuid() });

// Other headers pass through untouched; only the key is required.
export const confirmHoldHeaders = z.looseObject({ "idempotency-key": z.string().trim().min(1).max(128) });

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

export const idempotencyConflictResponse = z.object({ status: z.literal("conflict"), message: z.string() });

// The body is optional (Fastify passes a missing one as null); without a reason the default is stored.
export const releaseHoldBody = z.preprocess(
  (value) => value ?? {},
  z.object({ reason: z.string().trim().min(1).max(200).default("released_by_operator") }),
);

export const releaseHoldResponse = z.object({
  status: z.enum(["released", "not_releasable", "not_found", "service_unavailable", "invalid_request"]),
  message: z.string(),
  holdId: z.string().nullable(),
  holdStatus: z.enum(holdStatuses).nullable(),
  bookingRef: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ReleaseHoldResponse = z.infer<typeof releaseHoldResponse>;

// The reason is free text from the agent; a blank one is the same as none, and a long one is
// cut rather than rejected so the handoff never fails over wording.
export const requestHumanBody = z.object({
  callId,
  reason: optionalField(z.string().trim().transform((value) => value.slice(0, 200))),
});
export type RequestHumanBody = z.output<typeof requestHumanBody>;

export const requestHumanResponse = z.object({
  status: z.enum(["transferring", "service_unavailable", "invalid_request"]),
  message: z.string(),
});
export type RequestHumanResponse = z.infer<typeof requestHumanResponse>;

const wallPlace = z.object({ city: z.string(), state: z.string(), zip: z.string() });

// The load's lane as stored with the offer; null for offers recorded before lanes were kept.
// pickupAt is the TMS wall clock, YYYYMMDDHHMMSS with no timezone.
const wallLane = z.object({
  origin: wallPlace,
  destination: wallPlace,
  equipment: z.string(),
  miles: z.number().int(),
  pickupAt: z.string(),
});
export type WallLane = z.infer<typeof wallLane>;

// Operator only: posted rate and max buy are shown here and nowhere on the agent API.
const wallOffer = z.object({
  loadId: z.string(),
  round: z.number().int(),
  carrierAsk: z.number(),
  decision: z.enum(["accept", "counter", "reject"]),
  rateToSay: z.number().nullable(),
  postedRate: z.number().nullable(),
  maxBuy: z.number().nullable(),
  lane: wallLane.nullable(),
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
  // From the latest offer of the same call on this load.
  lane: wallLane.nullable(),
  createdAt: z.iso.datetime(),
});

const wallEvent = z.object({
  tool: z.string(),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const interventionKinds = ["whisper", "authorization", "listen", "takeover"] as const;

const wallIntervention = z.object({
  kind: z.enum(interventionKinds),
  loadId: z.string().nullable(),
  amountUsd: z.number().int().nullable(),
  message: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const wallCall = z.object({
  callId: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  eligible: z.boolean(),
  verified: z.boolean(),
  otp: z.object({ attempts: z.number().int(), locked: z.boolean(), expiresAt: z.iso.datetime().nullable() }),
  stage: z.enum(callStages),
  round: z.number().int().nullable(),
  risk: z.enum(callRisks),
  riskReason: z.string().nullable(),
  // Oldest first, the latest round of each load.
  offers: z.array(wallOffer),
  hold: wallHold.nullable(),
  // Oldest first, the last ones of the call only.
  events: z.array(wallEvent),
  // Oldest first, every operator action on the call.
  interventions: z.array(wallIntervention),
  createdAt: z.iso.datetime(),
});
export type WallCall = z.infer<typeof wallCall>;

export const tmsHealth = z.object({
  since: z.iso.datetime(),
  attempts: z.number().int(),
  retries: z.number().int(),
  faultsAbsorbed: z.number().int(),
  latencySamples: z.number().int(),
  latencyP50Ms: z.number().nullable(),
  latencyP95Ms: z.number().nullable(),
});

export const operatorWallResponse = z.object({
  status: z.literal("ok"),
  day: z.iso.date(),
  counters: z.object({
    calls: z.number().int(),
    booked: z.number().int(),
    // Refused at verification: not eligible, or OTP locked. A fact, not a fraud verdict.
    blocked: z.number().int(),
    dollarsGenerated: z.number(),
    marginSaved: z.number(),
  }),
  tmsHealth,
  // "human": a rep confirms every hold. "autonomous": create_hold books right away.
  autonomy: z.enum(autonomyModes),
});
export type OperatorWallResponse = z.infer<typeof operatorWallResponse>;

export const operatorWallUnavailableResponse = z.object({ status: z.literal("service_unavailable"), message: z.string() });

// An authorization is dollars on top of one load's scheduled counter; evaluateOffer caps it at that load's max buy.
export const createInterventionParams = z.object({ callId: z.string().trim().min(1).max(128) });
export const createInterventionBody = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("authorization"),
    loadId: loadIdInput,
    amountUsd: z.number().int().positive().max(maxAuthorizationUsd),
    message: z.string().trim().max(500).optional(),
  }),
  z.strictObject({ kind: z.enum(["whisper", "listen", "takeover"]), message: z.string().trim().max(500).optional() }),
]);
export type CreateInterventionBody = z.infer<typeof createInterventionBody>;
export const createInterventionResponse = z.object({ status: z.literal("recorded"), id: z.uuid() });

export const setAutonomyBody = z.strictObject({ mode: z.enum(autonomyModes) });
export const setAutonomyResponse = z.object({ status: z.literal("ok"), mode: z.enum(autonomyModes) });

// Booked loads around now: ETA in the last 24 h through pickups in the next 7 days, earliest pickup first.
// pickupAt and etaAt are instants; status is decided by the adapter (tripSql), progress is 0..1 at response time.
const operatorLoad = z.object({
  holdId: z.string(),
  loadId: z.string(),
  callId: z.string(),
  mcNumber: z.string().nullable(),
  // The FMCSA name at verification; null for calls verified before it was stored.
  carrierName: z.string().nullable(),
  agreedRate: z.number(),
  lane: wallLane,
  pickupAt: z.iso.datetime(),
  etaAt: z.iso.datetime(),
  status: z.enum(tripStatuses),
  progress: z.number().min(0).max(1),
});
export type OperatorLoad = z.infer<typeof operatorLoad>;

export const operatorLoadsResponse = z.object({ status: z.literal("ok"), loads: z.array(operatorLoad) });
export type OperatorLoadsResponse = z.infer<typeof operatorLoadsResponse>;

export const carrierStages = ["live", "negotiating", "needs_approval", "booked", "in_transit", "arrived", "lost"] as const;
export type CarrierStage = (typeof carrierStages)[number];
export const inboxTabs = ["needs_you", "live", "active", "closed", "all"] as const;
export const inboxSorts = ["priority", "recent", "rate", "pickup"] as const;

// A repeated key (`stage=live&stage=booked`) arrives as an array and a single one as a string.
// Empty entries are dropped, so `stage=` is no filter.
const listParam = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (value) =>
      (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v) => !(typeof v === "string" && v.trim() === "")),
    z.array(item).max(max),
  );

const operatorCarriersFields = z.object({
  tab: z.enum(inboxTabs).default("all"),
  stage: listParam(z.enum(carrierStages), carrierStages.length),
  equipment: listParam(equipmentInput, 10),
  origin: optionalField(stateInput),
  destination: optionalField(stateInput),
  // today is the desk's (Chicago) calendar day, like the wall; 7d and 30d are rolling windows.
  since: z.enum(["today", "7d", "30d"]).default("7d"),
  // A picked range of desk (Chicago) calendar days, both inclusive; when given it replaces `since`.
  from: optionalField(z.iso.date()),
  to: optionalField(z.iso.date()),
  // MC, DOT, carrier name or a load id the carrier was offered.
  q: optionalField(z.string().trim().max(64)),
  sort: z.enum(inboxSorts).default("priority"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  // Call ids HappyRobot reports as running; only the tower knows which calls are live.
  live: listParam(z.string().trim().min(1).max(128), 200),
});

// A range needs both ends, in order; ISO dates compare as strings.
const withDayRange = <T extends z.ZodType<{ from?: string | undefined; to?: string | undefined }>>(schema: T) =>
  schema
    .refine((query) => (query.from === undefined) === (query.to === undefined), { message: "from and to go together", path: ["to"] })
    .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
      message: "from must not be after to",
      path: ["to"],
    });

export const operatorCarriersQuery = withDayRange(operatorCarriersFields);
export type OperatorCarriersQuery = z.output<typeof operatorCarriersQuery>;

const operatorCarrier = z.object({
  // 'mc:<mc>', else 'dot:<dot>', else 'call:<call id>' of the carrier's calls.
  key: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  // The latest FMCSA name stored on one of its calls; null when none was stored.
  carrierName: z.string().nullable(),
  // Calls and distinct offered loads inside the `since` window.
  callsCount: z.number().int(),
  loadsCount: z.number().int(),
  lastActivityAt: z.iso.datetime(),
  carrierStage: z.enum(carrierStages),
  // The latest call is live and asked for a human.
  needsHuman: z.boolean(),
  // The trip of the carrier's latest booked hold; times are null when its load has no lane stored.
  nextTrip: z
    .object({ pickupAt: z.iso.datetime().nullable(), etaAt: z.iso.datetime().nullable(), status: z.enum(tripStatuses).nullable() })
    .nullable(),
  latestCall: wallCall,
});
export type OperatorCarrier = z.infer<typeof operatorCarrier>;

export const operatorCarriersResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(operatorCarrier),
  // Carriers in the selected tab and stages after the filters. The counts, per tab and per stage,
  // apply the same filters but not the tab or stage, so every rail row keeps its own count.
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  counts: z.object({ needsYou: z.number().int(), live: z.number().int(), active: z.number().int(), closed: z.number().int() }),
  stageCounts: z.record(z.enum(carrierStages), z.number().int()),
});
export type OperatorCarriersResponse = z.infer<typeof operatorCarriersResponse>;

export const operatorCarrierCallsParams = z.object({ key: z.string().trim().min(1).max(128) });
// The carrier summary reads the same window and live calls as the list, so it matches the carrier's row.
export const operatorCarrierCallsQuery = withDayRange(operatorCarriersFields.pick({ since: true, from: true, to: true, live: true }));
export type OperatorCarrierCallsQuery = z.output<typeof operatorCarrierCallsQuery>;
// Newest call first; an unknown key answers an empty list. The carrier is its list row in the
// `since` window, null when it has no call there.
export const operatorCarrierCallsResponse = z.object({ status: z.literal("ok"), calls: z.array(wallCall), carrier: operatorCarrier.nullable() });
export type OperatorCarrierCallsResponse = z.infer<typeof operatorCarrierCallsResponse>;
