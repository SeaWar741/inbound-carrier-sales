import { z } from "zod";
import { maxAuthorizationUsd, otpDigits } from "./constants.ts";
import { callRisks, callStages } from "./domain/call-stage.ts";
import { tripStatuses } from "./domain/trip.ts";
import { feasibilities, type TripSnapshot } from "./domain/trip-estimate.ts";
import { cityInput, equipmentInput, loadIdInput, spokenLoadId, stateInput, zipInput } from "./infra/tms/codec.ts";
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
    // A load the carrier names by number; when present the lane fields are ignored.
    loadId: optionalField(spokenLoadId),
  })
  .refine(
    (b) => b.loadId !== undefined || b.originCity !== undefined || b.originState !== undefined || b.originZip !== undefined,
    { message: "Provide a load number or an origin city, state or zip" },
  )
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

// The stored trip snapshot as the wall reads it back (the estimator writes domain TripSnapshot). Holds
// stored before lateHours and deliveryAt existed read back as on time with no appointment, so the wall
// never fails on them; that is the one way this schema is wider than the domain type.
export const tripSnapshot = z.object({
  rate: z.number().int(),
  dieselUsd: z.number().int(),
  tollsUsd: z.number().int(),
  carrierNetUsd: z.number().int(),
  feasibility: z.enum(feasibilities),
  legalEtaAt: z.iso.datetime(),
  legalHours: z.number(),
  lateHours: z.number().default(0),
  deliveryAt: z.iso.datetime().nullable().default(null),
  netPerHour: z.number().int(),
  dieselPerGal: z.number(),
  tollShare: z.number().nullable(),
}) satisfies z.ZodType<Omit<TripSnapshot, "deliveryAt"> & { deliveryAt: string | null }>;

// Only what the agent speaks from: the message, the net and whether the window needs a team.
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
  carrierNetUsd: tripSnapshot.shape.carrierNetUsd.nullable(),
  feasibility: tripSnapshot.shape.feasibility.nullable(),
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
  // Loads we notified this carrier about that are still bookable, newest first; [] on every answer but ok.
  notifiedLoadIds: z.array(z.string()),
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
    "window_too_tight",
    "tms_unavailable",
    "service_unavailable",
    "invalid_request",
  ]),
  message: z.string(),
  holdId: z.string().nullable(),
  holdStatus: z.enum(holdStatuses).nullable(),
});
export type CreateHoldResponse = z.infer<typeof createHoldResponse>;

// Flat fields like searchLoadsBody. Consent is a tool string: only an explicit yes counts.
export const saveCapacityBody = z.object({
  callId,
  city: cityInput,
  state: stateInput,
  freeDate: z.iso.date(),
  equipmentType: optionalEquipment,
  preferredDestinationState: optionalField(stateInput),
  consent: z.preprocess(
    (value) => value === true || (typeof value === "string" && /^\s*(yes|true)\s*$/i.test(value)),
    z.boolean(),
  ),
});
export type SaveCapacityBody = z.output<typeof saveCapacityBody>;

export const saveCapacityResponse = z.object({
  status: z.enum(["ok", "not_verified", "no_consent", "invalid_request", "service_unavailable"]),
  message: z.string(),
});
export type SaveCapacityResponse = z.infer<typeof saveCapacityResponse>;

// A load the board has open that fits a saved truck. The posted rate only; the max buy never leaves the adapter.
const capacityLoad = z.object({
  loadId: z.string(),
  origin: z.string(),
  destination: z.string(),
  // Desk time, readable: "Oct 3, 8:00 AM".
  pickupDateTime: z.string(),
  equipmentType: z.string(),
  loadboardRate: z.number(),
  miles: z.number(),
  // Delivers to the carrier's preferred destination state; these rank first.
  preferred: z.boolean(),
});

export const operatorCapacityResponse = z.object({
  status: z.literal("ok"),
  trucks: z.array(
    z.object({
      id: z.string(),
      mcNumber: z.string(),
      carrierName: z.string().nullable(),
      city: z.string(),
      state: z.string(),
      // Null means any equipment.
      equipment: z.string().nullable(),
      freeDate: z.iso.date(),
      preferredDestinationState: z.string().nullable(),
      // The channel the carrier verified on; the contact itself never leaves the adapter.
      noticeChannel: z.enum(["email", "sms"]).nullable(),
      notifiedLoadId: z.string().nullable(),
      notifiedAt: z.iso.datetime().nullable(),
      // Null when the board could not be read for this truck.
      loads: z.array(capacityLoad).nullable(),
    }),
  ),
});
export type OperatorCapacityResponse = z.infer<typeof operatorCapacityResponse>;

export const notifyCapacityParams = z.object({ id: z.uuid() });
export const notifyCapacityBody = z.strictObject({ loadId: loadIdInput });
export const notifyCapacityResponse = z.object({
  status: z.enum(["sent", "already_notified", "load_unavailable", "no_contact", "failed"]),
  message: z.string(),
});
export type NotifyCapacityResponse = z.infer<typeof notifyCapacityResponse>;

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

// One negotiation round; wallOffer keeps only the latest round per load.
const wallRound = wallOffer.pick({ loadId: true, round: true, carrierAsk: true, decision: true, rateToSay: true, createdAt: true });

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
  // The estimate snapshotted when the hold was placed; null on holds without one.
  trip: tripSnapshot.nullable(),
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
  rounds: z.array(wallRound),
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
    // Calls that got a load offered: an offer row, or a search that returned loads.
    offered: z.number().int(),
    booked: z.number().int(),
    // Today's calls with at least one booked hold: the win rate's numerator, so it never passes offered.
    bookedCalls: z.number().int(),
    // Refused at verification: not eligible, or OTP locked. A fact, not a fraud verdict.
    blocked: z.number().int(),
    // Sum of agreed rates on today's booked holds.
    bookedValue: z.number(),
    // Trucks saved in the last 7 days, those sent a load, and those that then booked that load.
    capacity: z.object({ captured: z.number().int(), notified: z.number().int(), bookedAfterNotice: z.number().int() }),
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

export const networkViews = ["all", "new", "at_risk", "top", "growth"] as const;
export const carrierRelationships = ["new", "at_risk", "active"] as const;
export const networkSorts = ["mc", "carrier", "lastCall", "calls", "bookings"] as const;
export const demandSorts = ["lane", "equipment", "unmet", "thisWeek", "carriers"] as const;
export const pageSizes = [10, 25, 50] as const;

const sortDir = z.enum(["asc", "desc"]).default("desc");
const pageSize = z.coerce.number().pipe(z.literal(pageSizes)).default(25);

// The bar filters and a view over a fixed 30 day window, long enough to see a carrier's pattern.
export const operatorNetworkQuery = operatorCarriersFields.pick({ equipment: true, origin: true, page: true }).extend({
  view: z.enum(networkViews).default("all"),
  // MC, DOT or carrier name.
  q: optionalField(z.string().trim().max(64)),
  sort: z.enum(networkSorts).default("lastCall"),
  dir: sortDir,
  pageSize,
});
export type OperatorNetworkQuery = z.output<typeof operatorNetworkQuery>;

const networkCarrier = z.object({
  key: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  // new, else at_risk, else active; lifetime facts decide it, not the window.
  relationship: z.enum(carrierRelationships),
  // Independent of the relationship and of each other.
  top: z.boolean(),
  // One of the carrier's lanes is open: the board has an open load on that exact origin, destination
  // and equipment (a search's Any matches every value), or on its origin and equipment when the carrier
  // booked that exact lane at least twice. Under an equipment or origin filter, only an open lane that
  // matches it counts.
  growth: z.boolean(),
  facts: z.object({
    lifetimeCalls: z.number().int(),
    lifetimeBookings: z.number().int(),
    lastCallAt: z.iso.datetime(),
    // Calls in the last 14 days and in the 14 days before those.
    callsRecent: z.number().int(),
    callsPrior: z.number().int(),
    // The rest are inside the window; negotiable calls have at least one offer.
    calls: z.number().int(),
    negotiableCalls: z.number().int(),
    bookings: z.number().int(),
  }),
  // The carrier's lanes in the window, from its searches and negotiated loads; null means any. Count is
  // calls; open means the board has an open load on it now, and open lanes come first.
  lanes: z.array(
    z.object({
      originState: z.string().nullable(),
      destinationState: z.string().nullable(),
      equipment: z.string().nullable(),
      count: z.number().int(),
      open: z.boolean(),
    }),
  ),
});
export type NetworkCarrier = z.infer<typeof networkCarrier>;

export const operatorNetworkResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(networkCarrier),
  // Carriers in the view after the filters; the counts apply the filters but not the view.
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  counts: z.object({ all: z.number().int(), atRisk: z.number().int(), growth: z.number().int() }),
  // Over the filtered carriers, not the view: carriers with a call in the window, their bookings and negotiated loads.
  kpis: z.object({ called: z.number().int(), booked: z.number().int(), negotiated: z.number().int() }),
  // Distinct listed carriers per open lane (the top 5) and per origin state with one, without the
  // filters or the view, so the side panel keeps its shape while the list narrows.
  openLanes: z.array(z.object({ originState: z.string(), equipment: z.string(), carriers: z.number().int() })),
  openOrigins: z.array(z.object({ originState: z.string(), carriers: z.number().int() })),
  // False when the TMS board could not be read; growth is then false for every carrier.
  boardAvailable: z.boolean(),
});
export type OperatorNetworkResponse = z.infer<typeof operatorNetworkResponse>;

// The unmet demand radar reads the last 4 desk (Chicago) weeks, this one included; the bar filters narrow the rows.
export const operatorDemandQuery = operatorCarriersFields.pick({ equipment: true, origin: true, page: true }).extend({
  // An origin or destination state, or an MC or carrier name among the lane's asks; it keeps rows, never changes their counts.
  q: optionalField(z.string().trim().max(64)),
  // The next move: source keeps lanes with searches that found nothing, rate those with offers that did not book.
  next: optionalField(z.enum(["source", "rate"])),
  sort: z.enum(demandSorts).default("unmet"),
  dir: sortDir,
  pageSize,
});
export type OperatorDemandQuery = z.output<typeof operatorDemandQuery>;

// One lane carriers asked for and we did not cover; a null destination or equipment is the "Any" the
// carrier asked for. Only unmet asks count: a search that found a load is left out everywhere.
// No search is linked to the booking it led to and no carrier rejection is stored, so neither is counted.
const demandLane = z.object({
  originState: z.string(),
  destinationState: z.string().nullable(),
  equipment: z.string().nullable(),
  // Searches that returned no load.
  noMatch: z.number().int(),
  // Loads negotiated on a call that never got a hold (held, confirming or booked) on that call.
  offeredNoBooking: z.number().int(),
  // Unmet asks (noMatch + offeredNoBooking) in this and the previous desk week.
  thisWeek: z.number().int(),
  previousWeek: z.number().int(),
  // Distinct carriers behind the unmet asks.
  carriers: z.number().int(),
});
export type DemandLane = z.infer<typeof demandLane>;

export const operatorDemandResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(demandLane),
  total: z.number().int(),
  // Across every row the filters keep, not only this page.
  totals: z.object({
    noMatch: z.number().int(),
    offeredNoBooking: z.number().int(),
    carriers: z.number().int(),
    thisWeek: z.number().int(),
    previousWeek: z.number().int(),
  }),
  // Unmet asks per origin state over every lane, without the filters.
  origins: z.array(z.object({ originState: z.string(), unmet: z.number().int() })),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type OperatorDemandResponse = z.infer<typeof operatorDemandResponse>;

// One radar row: destination and equipment left out select the "Any" row, not every row.
export const operatorDemandCarriersQuery = z.object({
  origin: stateInput,
  destination: optionalField(stateInput),
  equipment: optionalField(equipmentInput),
  page: operatorCarriersFields.shape.page,
});
export type OperatorDemandCarriersQuery = z.output<typeof operatorDemandCarriersQuery>;

const demandCarrier = z.object({
  key: z.string(),
  mcNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  // The carrier's unmet asks on the row's lane: searches that found nothing plus offered loads without a booking.
  asks: z.number().int(),
});
export type DemandCarrier = z.infer<typeof demandCarrier>;

export const operatorDemandCarriersResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(demandCarrier),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type OperatorDemandCarriersResponse = z.infer<typeof operatorDemandCarriersResponse>;
