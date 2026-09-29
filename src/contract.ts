import { z } from "zod";
import { otpDigits } from "./constants.ts";
import { equipmentTypes, loadIdInput } from "./infra/tms/codec.ts";
import { holdStatuses } from "./infra/twin-schemas.ts";

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

// Mirrors the TMS codec's normalization so a bad filter is a 200 invalid_request, not a thrown error.
const city = z.string().trim().min(1).max(30).regex(/^[^|\r\n]+$/);
const state = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const zip = z.string().trim().regex(/^\d{5}$/);

// Flat fields because each is one tool parameter; the route reads origin/destination objects.
export const searchLoadsBody = z
  .object({
    callId,
    originCity: optionalField(city),
    originState: optionalField(state),
    originZip: optionalField(zip),
    destinationCity: optionalField(city),
    destinationState: optionalField(state),
    destinationZip: optionalField(zip),
    equipmentType: z
      .string()
      .trim()
      .toUpperCase()
      .transform((s) => s.replace(/[\s-]+/g, "_"))
      .pipe(z.enum(equipmentTypes)),
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
