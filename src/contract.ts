import { z } from "zod";
import { otpDigits } from "./constants.ts";
import { equipmentTypes, loadIdInput } from "./infra/tms/codec.ts";

// Request and response schemas for the agent and operator APIs.

// Callers say "MC 123456" or "DOT# 0123456"; stored and queried as bare digits without leading zeros.
const carrierIdentifier = (prefix: "MC" | "DOT") =>
  z
    .string()
    .trim()
    .transform((value) => value.replace(new RegExp(`^${prefix}\\s*[#:-]?\\s*`, "i"), ""))
    .pipe(z.string().regex(/^\d{1,8}$/, `${prefix} number must be 1 to 8 digits`))
    .transform((digits) => digits.replace(/^0+(?=\d)/, ""));

export const verifyCarrierBody = z
  .object({
    callId: z.string().trim().min(1).max(128),
    mcNumber: carrierIdentifier("MC").optional(),
    dotNumber: carrierIdentifier("DOT").optional(),
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
const place = z
  .object({
    city: z.string().trim().min(1).max(30).regex(/^[^|\r\n]+$/).optional(),
    state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
    zip: z.string().trim().regex(/^\d{5}$/).optional(),
  })
  .refine((p) => p.city !== undefined || p.state !== undefined || p.zip !== undefined, {
    message: "Provide a city, state or zip",
  });

export const searchLoadsBody = z.object({
  callId,
  origin: place,
  destination: place.optional(),
  equipmentType: z
    .string()
    .trim()
    .toUpperCase()
    .transform((s) => s.replace(/[\s-]+/g, "_"))
    .pipe(z.enum(equipmentTypes)),
  pickupDate: z.iso.date().optional(),
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
  carrierAsk: z.number().int().positive().max(1_000_000),
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

export const sendOtpBody = z.object({ callId, channel: z.enum(["email", "sms"]) });
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

export const checkOtpBody = z.object({ callId, code: z.string().trim().regex(new RegExp(`^\\d{${otpDigits}}$`), `code must be ${otpDigits} digits`) });
export type CheckOtpBody = z.output<typeof checkOtpBody>;

export const checkOtpResponse = z.object({
  status: z.enum(["ok", "wrong_code", "expired", "locked", "no_active_code", "service_unavailable", "invalid_request"]),
  message: z.string(),
  verified: z.boolean(),
  attemptsLeft: z.number().int().nullable(),
});
export type CheckOtpResponse = z.infer<typeof checkOtpResponse>;
