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
export type Channel = "voice" | "text";

// Same bounds the adapter enforces, so the tower rejects what the adapter would refuse.
export const maxAuthorizationUsd = 1_000;
// Mirrors the length of the adapter's concessionSchedule: the last round of a negotiation.
export const finalRound = 3;
export const loadIdInput = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,12}$/);
export const callIdInput = z.string().trim().min(1).max(128);
export const messageInput = z.string().trim().max(500);

const wallPlace = z.object({ city: z.string(), state: z.string(), zip: z.string() });

// Null for offers recorded before lanes were kept, and when an adapter that predates lanes omits it.
// pickupAt is the TMS wall clock, YYYYMMDDHHMMSS.
const wallLane = z.object({
  origin: wallPlace,
  destination: wallPlace,
  equipment: z.string(),
  miles: z.number().int(),
  pickupAt: z.string(),
});
export type WallLane = z.infer<typeof wallLane>;

export const feasibilities = ["solo", "team", "impossible"] as const;
export type Feasibility = (typeof feasibilities)[number];

// The hold's trip estimate: what the carrier keeps at the agreed rate after diesel and tolls, and
// the legal (HOS) ETA. Null for holds placed before estimates, and when an older adapter omits it.
const tripSnapshot = z.object({
  rate: z.number().int(),
  dieselUsd: z.number().int(),
  tollsUsd: z.number().int(),
  carrierNetUsd: z.number().int(),
  feasibility: z.enum(feasibilities),
  legalEtaAt: z.iso.datetime(),
  legalHours: z.number(),
  // Hours past the delivery appointment the chosen crew lands; snapshots stored before it read as on time.
  lateHours: z.number().default(0),
  // The TMS delivery appointment; null on snapshots stored before it was recorded.
  deliveryAt: z.iso.datetime().nullable().default(null),
  netPerHour: z.number().int(),
  dieselPerGal: z.number(),
  // 0..1: the share of the route on toll roads.
  tollShare: z.number().nullable(),
});
export type TripSnapshot = z.infer<typeof tripSnapshot>;

const wallOffer = z.object({
  loadId: z.string(),
  round: z.number().int(),
  carrierAsk: z.number(),
  decision: z.enum(["accept", "counter", "reject"]),
  rateToSay: z.number().nullable(),
  postedRate: z.number().nullable(),
  maxBuy: z.number().nullable(),
  lane: wallLane.nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type WallOffer = z.infer<typeof wallOffer>;

const wallHold = z.object({
  holdId: z.string(),
  loadId: z.string(),
  status: z.enum(holdStatuses),
  agreedRate: z.number(),
  postedRate: z.number().nullable(),
  maxBuy: z.number().nullable(),
  bookingRef: z.string().nullable(),
  lane: wallLane.nullable().default(null),
  trip: tripSnapshot.nullable().default(null),
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
  // Every round of every load; an older adapter sends none.
  rounds: z.array(wallOffer.pick({ loadId: true, round: true, carrierAsk: true, decision: true, rateToSay: true, createdAt: true })).default([]),
  hold: wallHold.nullable(),
  events: z.array(wallEvent),
  interventions: z.array(wallIntervention),
  createdAt: z.iso.datetime(),
});
export type AdapterWallCall = z.infer<typeof adapterWallCall>;

// "human": a rep confirms every hold in the tower. "autonomous": the agent's hold books at once.
export const autonomyModes = ["human", "autonomous"] as const;
export type AutonomyMode = (typeof autonomyModes)[number];
export const setAutonomyBody = z.strictObject({ mode: z.enum(autonomyModes) });

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
    offered: z.number().int(),
    booked: z.number().int(),
    blocked: z.number().int(),
    bookedValue: z.number(),
    capacity: z.object({ captured: z.number().int(), notified: z.number().int(), bookedAfterNotice: z.number().int() }),
  }),
  tmsHealth,
  // Defaults to the safe mode when an older adapter does not send it.
  autonomy: z.enum(autonomyModes).default("human"),
});
export type TowerWall = z.infer<typeof adapterWallResponse>;

// A wall call as the tower serves it: the adapter row plus the live HappyRobot session, if any.
export type TowerCall = Omit<AdapterWallCall, "stage"> & {
  stage: CallStage;
  live: boolean;
  sessionId: string | null;
  channel: Channel | null;
};

// The live state HappyRobot reports for one call, keyed by call id (run id).
export type LiveRun = { session: { id: string; channel: Channel } | null };

// Stages the call data settles on its own; every other stage of a call that is no longer running is "ended".
const settledStages = new Set<CallStage>(["holding", "booked", "released"]);

// Overlays the HappyRobot run on an adapter call. `running` undefined means HappyRobot could not
// be reached: the call keeps its adapter stage and is not live.
export function toTowerCall(call: AdapterWallCall, running: Map<string, LiveRun> | undefined): TowerCall {
  if (running === undefined) return { ...call, live: false, sessionId: null, channel: null };
  const run = running.get(call.callId);
  const stage = run === undefined && !settledStages.has(call.stage) ? "ended" : call.stage;
  return { ...call, stage, live: run?.session != null, sessionId: run?.session?.id ?? null, channel: run?.session?.channel ?? null };
}

export const tripStatuses = ["upcoming", "in_transit", "arrived"] as const;
export type TripStatus = (typeof tripStatuses)[number];

// Booked loads around now: ETA in the last 24 h through pickups in the next 7 days, earliest pickup first.
// pickupAt and etaAt are instants; progress is 0..1 at response time.
const adapterLoad = z.object({
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
export type TowerLoad = z.infer<typeof adapterLoad>;

export const adapterLoadsResponse = z.object({ status: z.literal("ok"), loads: z.array(adapterLoad) });
export type TowerLoads = z.infer<typeof adapterLoadsResponse>;

export const carrierStages = ["live", "negotiating", "needs_approval", "booked", "in_transit", "arrived", "lost"] as const;
export type CarrierStage = (typeof carrierStages)[number];
export const inboxTabs = ["needs_you", "live", "active", "closed", "all"] as const;
export const inboxSorts = ["priority", "recent", "rate", "pickup"] as const;

const adapterCarrier = z.object({
  // 'mc:<mc>', else 'dot:<dot>', else 'call:<call id>' of the carrier's calls. Encode it in URLs.
  key: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  callsCount: z.number().int(),
  loadsCount: z.number().int(),
  lastActivityAt: z.iso.datetime(),
  carrierStage: z.enum(carrierStages),
  needsHuman: z.boolean(),
  nextTrip: z
    .object({ pickupAt: z.iso.datetime().nullable(), etaAt: z.iso.datetime().nullable(), status: z.enum(tripStatuses).nullable() })
    .nullable(),
  latestCall: adapterWallCall,
});

export const adapterCarriersResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(adapterCarrier),
  // Carriers in the selected tab and stages after the filters. The counts, per tab and per stage,
  // apply the same filters but not the tab or stage, so every rail row keeps its own count.
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  counts: z.object({ needsYou: z.number().int(), live: z.number().int(), active: z.number().int(), closed: z.number().int() }),
  stageCounts: z.record(z.enum(carrierStages), z.number().int()),
});
export type AdapterCarriersResponse = z.infer<typeof adapterCarriersResponse>;

// A carrier as the tower serves it: its latest call carries the live HappyRobot session, like the wall.
export type TowerCarrier = Omit<AdapterCarriersResponse["rows"][number], "latestCall"> & { latestCall: TowerCall };
export type TowerCarriers = Omit<AdapterCarriersResponse, "rows"> & {
  rows: TowerCarrier[];
  // True when HappyRobot could not be reached; stages then ignore which calls are live.
  liveUnavailable: boolean;
};

// Newest call first; an unknown key answers an empty list. The carrier is its list row in the
// `since` window, null when it has no call there.
export const adapterCarrierCallsResponse = z.object({ status: z.literal("ok"), calls: z.array(adapterWallCall), carrier: adapterCarrier.nullable() });
export type AdapterCarrierCallsResponse = z.infer<typeof adapterCarrierCallsResponse>;
// One carrier's calls as the tower serves them: each carries the live HappyRobot session, like the wall.
export type TowerCarrierCalls = Omit<AdapterCarrierCallsResponse, "calls" | "carrier"> & {
  calls: TowerCall[];
  carrier: TowerCarrier | null;
  // True when HappyRobot could not be reached; calls then carry the adapter stage and live: false.
  liveUnavailable: boolean;
};

export const networkViews = ["all", "new", "at_risk", "top", "growth"] as const;
export const networkSorts = ["mc", "carrier", "lastCall", "calls", "bookings"] as const;
export const demandSorts = ["lane", "equipment", "unmet", "thisWeek", "carriers"] as const;
export const pageSizes = [10, 25, 50] as const;
export const carrierRelationships = ["new", "at_risk", "active"] as const;

const networkCarrier = z.object({
  key: z.string(),
  mcNumber: z.string().nullable(),
  dotNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  // new, else at_risk, else active; lifetime facts decide it, not the window.
  relationship: z.enum(carrierRelationships),
  // Tags independent of the relationship and of each other. Growth: one of the carrier's lanes has an
  // open load on the board now, one that matches the equipment and origin filters when they are set.
  top: z.boolean(),
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
  // The carrier's lanes in the window; null means any. Open lanes come first.
  lanes: z.array(
    z.object({ originState: z.string().nullable(), destinationState: z.string().nullable(), equipment: z.string().nullable(), count: z.number().int(), open: z.boolean() }),
  ),
});
export type NetworkCarrier = z.infer<typeof networkCarrier>;

export const adapterNetworkResponse = z.object({
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
export type TowerNetwork = z.infer<typeof adapterNetworkResponse>;

// One lane carriers asked for in the last 4 desk weeks and we did not cover; a null destination or
// equipment is the "Any" the carrier asked for. Only unmet asks count, here and in every total.
const demandLane = z.object({
  originState: z.string(),
  destinationState: z.string().nullable(),
  equipment: z.string().nullable(),
  // Searches that returned no load.
  noMatch: z.number().int(),
  // Loads offered on a call that never got a hold on that call.
  offeredNoBooking: z.number().int(),
  // Unmet asks (noMatch + offeredNoBooking) in this and the previous desk week.
  thisWeek: z.number().int(),
  previousWeek: z.number().int(),
  // Distinct carriers behind the unmet asks.
  carriers: z.number().int(),
});
export type DemandLane = z.infer<typeof demandLane>;

export const adapterDemandResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(demandLane),
  total: z.number().int(),
  // Across every lane the filters keep, not only this page.
  totals: z.object({
    noMatch: z.number().int(),
    offeredNoBooking: z.number().int(),
    carriers: z.number().int(),
    thisWeek: z.number().int(),
    previousWeek: z.number().int(),
  }),
  // Unmet asks per origin state over every lane, without the filters, so the map keeps its shape; never 0.
  origins: z.array(z.object({ originState: z.string(), unmet: z.number().int() })),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type TowerDemand = z.infer<typeof adapterDemandResponse>;

const demandCarrier = z.object({
  key: z.string(),
  mcNumber: z.string().nullable(),
  carrierName: z.string().nullable(),
  // The carrier's unmet asks on the row's lane: searches that found nothing plus offered loads without a booking.
  asks: z.number().int(),
});
export type DemandCarrier = z.infer<typeof demandCarrier>;

export const adapterDemandCarriersResponse = z.object({
  status: z.literal("ok"),
  rows: z.array(demandCarrier),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type TowerDemandCarriers = z.infer<typeof adapterDemandCarriersResponse>;

// A truck a carrier said frees up, with the open loads that fit it. Only the posted rate; the max
// buy never leaves the adapter. pickupDateTime is already desk time, readable ("Oct 3, 8:00 AM").
const capacityLoad = z.object({
  loadId: z.string(),
  origin: z.string(),
  destination: z.string(),
  pickupDateTime: z.string(),
  equipmentType: z.string(),
  loadboardRate: z.number(),
  miles: z.number(),
  // Delivers to the carrier's preferred destination state; the adapter ranks these first.
  preferred: z.boolean(),
});
export type CapacityLoad = z.infer<typeof capacityLoad>;

export const noticeChannels = ["email", "sms"] as const;

const capacityTruck = z.object({
  id: z.string(),
  mcNumber: z.string(),
  carrierName: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  // Null means any equipment.
  equipment: z.string().nullable(),
  freeDate: z.iso.date(),
  preferredDestinationState: z.string().nullable(),
  // Null when the carrier has no verified contact, so it cannot be notified.
  noticeChannel: z.enum(noticeChannels).nullable(),
  notifiedLoadId: z.string().nullable(),
  notifiedAt: z.iso.datetime().nullable(),
  // Null when the board could not be read for this truck.
  loads: z.array(capacityLoad).nullable(),
});
export type CapacityTruck = z.infer<typeof capacityTruck>;

export const adapterCapacityResponse = z.object({ status: z.literal("ok"), trucks: z.array(capacityTruck) });
export type TowerCapacity = z.infer<typeof adapterCapacityResponse>;

export const notifyCapacityBody = z.strictObject({ loadId: loadIdInput });
export const notifyCapacityResponse = z.object({
  status: z.enum(["sent", "already_notified", "load_unavailable", "no_contact", "failed"]),
  message: z.string(),
});
export type NotifyCapacityResponse = z.infer<typeof notifyCapacityResponse>;

export type ErrorResponse = { status: string; message: string };

// Request bodies the browser sends to the tower.
// The session is resolved on the server from the call id in the path, never taken from the browser.
export const voiceTokenBody = z.strictObject({ mode: z.enum(["listen", "takeover"]) });
export type VoiceTokenBody = z.infer<typeof voiceTokenBody>;
export type VoiceTokenResponse = { url: string; token: string; roomName: string };

export const interventionBody = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whisper"), message: messageInput.min(1) }),
  z.strictObject({
    kind: z.literal("authorization"),
    loadId: loadIdInput,
    amountUsd: z.number().int().positive().max(maxAuthorizationUsd),
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
