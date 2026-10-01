import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../config.ts";
import { noticeCallbackDays, otpMaxSendsPerDotPerHour, otpTtlSeconds } from "../constants.ts";
import { checkOtpBody, checkOtpResponse, sendOtpBody, sendOtpResponse, type CheckOtpResponse, type SendOtpResponse } from "../contract.ts";
import { checkCode, generateCode, hashCode } from "../domain/otp.ts";
import { maskEmail, maskPhone } from "../domain/verification.ts";
import type { CensusClient } from "../infra/census-client.ts";
import type { OtpChannel, OtpDeliveryClient } from "../infra/otp-delivery-client.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";
import { findLoad, isOpen, loadsHeldByOtherCalls } from "./loads.ts";

export type OtpRouteDeps = {
  config: Pick<Config, "OTP_DELIVERY_MODE" | "OTP_DEMO_EMAIL" | "OTP_DEMO_PHONE" | "OTP_HASH_SECRET" | "OTP_FIXED_CODE">;
  census: Pick<CensusClient, "contactByDot">;
  delivery: Pick<OtpDeliveryClient, "send" | "supports">;
  twin: Pick<TwinClient, "query">;
  tms: Pick<TmsClient, "getLoad">;
};

const messages = {
  notEligible: "I need to verify your carrier before I can send a code.",
  tooMany: "I've already sent several codes for this carrier. Please try again in an hour.",
  noContact: "I don't have that contact method on file for your carrier.",
  channelUnavailable: "I can't send codes that way right now. I can email it instead.",
  deliveryUnavailable: "I couldn't send the code just now. Please give me a moment and try again.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalidSend: "Tell me whether you'd like the code by email or by text.",
  invalidCheck: "The code should be six digits. Could you read it to me again?",
  verified: "Thanks, you're verified.",
  expired: "That code has expired. I can send you a new one.",
  locked: "That's too many attempts for this code. I can send you a new one.",
  noActiveCode: "I haven't sent you a code on this call yet. Would you like me to send one?",
} as const;

const notSent = (status: Exclude<SendOtpResponse["status"], "ok">, message: string): SendOtpResponse => ({
  status,
  message,
  sent: false,
  maskedDestination: null,
  expiresInSeconds: null,
});

const notVerified = (status: Exclude<CheckOtpResponse["status"], "ok">, message: string, attemptsLeft: number | null = null): CheckOtpResponse => ({
  status,
  message,
  verified: false,
  attemptsLeft,
  notifiedLoadIds: [],
});

const codeMessage = (code: string) => ({
  subject: "Your verification code",
  body: `Your carrier verification code is ${code}. It expires in ${otpTtlSeconds / 60} minutes. If you did not request it, you can ignore this message.`,
});

// Census phones are 10-digit US numbers; SMS needs E.164.
function toE164(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

const sendStateRow = z.object({
  dot_number: z.string().nullable(),
  eligible: z.boolean(),
  sends_last_hour: z.coerce.number().int(),
});

const challengeRow = z.object({
  otp_hash: z.string(),
  otp_expires_at: z.coerce.date(),
  otp_attempts: z.coerce.number().int(),
  db_now: z.coerce.date(),
});

// Loads we notified this carrier about lately that are still OPEN and not held by another call, newest first.
// Capped at 3 because each is one TMS read on the login path. Any failure only means the agent does not bring
// them up, so it never blocks verification.
async function notifiedLoadIds(deps: OtpRouteDeps, callId: string, mcNumber: string | null, log: FastifyBaseLogger): Promise<string[]> {
  if (mcNumber === null) return [];
  try {
    const rows = await deps.twin.query(
      sql`SELECT notified_load_id FROM truck_capacity
          WHERE mc_number = ${mcNumber} AND notified_load_id IS NOT NULL
            AND notified_at::timestamptz > now() - ${noticeCallbackDays} * interval '1 day'
          ORDER BY notified_at DESC LIMIT 3`,
      z.object({ notified_load_id: z.string() }),
    );
    const ids = [...new Set(rows.map((row) => row.notified_load_id))];
    const loads = await Promise.all(ids.map((id) => findLoad(deps.tms, id)));
    const open = ids.filter((_, i) => isOpen(loads[i]?.status ?? ""));
    const held = await loadsHeldByOtherCalls(deps.twin, callId, open);
    return open.filter((id) => !held.has(id));
  } catch (error) {
    log.warn({ err: error }, "notified loads unavailable");
    return [];
  }
}

export function otpRoutes(deps: OtpRouteDeps): FastifyPluginAsync {
  async function destinationFor(channel: OtpChannel, dotNumber: string): Promise<string | undefined> {
    // Demo mode (the default) never contacts the carrier on file.
    if (deps.config.OTP_DELIVERY_MODE === "demo") {
      return channel === "email" ? deps.config.OTP_DEMO_EMAIL : deps.config.OTP_DEMO_PHONE;
    }
    const contact = await deps.census.contactByDot(dotNumber);
    if (channel === "email") return contact?.email ?? undefined;
    const phone = contact?.cellPhone ?? contact?.phone;
    return phone ? toE164(phone) : undefined;
  }

  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(
      invalidRequestHandler((request) =>
        request.url.endsWith("/send")
          ? notSent("invalid_request", messages.invalidSend)
          : notVerified("invalid_request", messages.invalidCheck),
      ),
    );

    app.post("/otp/send", { schema: { body: sendOtpBody, response: { 200: sendOtpResponse } } }, async (request) => {
      const { callId, channel } = request.body;
      try {
        // Counts every send on any call whose last send was within the hour, which
        // over-counts a little and so errs toward refusing; a send log table makes it exact.
        const [call] = await deps.twin.query(
          sql`SELECT c.dot_number, c.eligible,
                (SELECT COALESCE(sum(d.otp_sends), 0) FROM calls d
                  WHERE d.dot_number = c.dot_number AND d.otp_last_sent_at > now() - interval '1 hour') AS sends_last_hour
              FROM calls c WHERE c.call_id = ${callId}`,
          sendStateRow,
        );
        if (!call?.eligible || !call.dot_number) return notSent("not_eligible", messages.notEligible);
        // The per-DOT limit protects a carrier's inbox; the local simulator (fixed code, demo delivery) has none to protect.
        if (!deps.config.OTP_FIXED_CODE && call.sends_last_hour >= otpMaxSendsPerDotPerHour) {
          return notSent("too_many_requests", messages.tooMany);
        }
        if (!deps.delivery.supports(channel)) return notSent("channel_unavailable", messages.channelUnavailable);

        const destination = await destinationFor(channel, call.dot_number);
        if (!destination) return notSent("no_contact_on_file", messages.noContact);

        const code = deps.config.OTP_FIXED_CODE ?? generateCode();
        await deps.twin.query(
          sql`UPDATE calls SET otp_hash = ${hashCode(deps.config.OTP_HASH_SECRET, callId, code)},
                otp_expires_at = now() + ${otpTtlSeconds} * interval '1 second',
                otp_attempts = 0, otp_sends = otp_sends + 1, otp_last_sent_at = now(),
                otp_channel = ${channel}, otp_destination = ${destination}
              WHERE call_id = ${callId} RETURNING call_id`,
          z.unknown(),
        );
        try {
          await deps.delivery.send(channel, destination, codeMessage(code));
        } catch (error) {
          request.log.warn({ err: error, channel }, "otp delivery failed");
          return notSent("delivery_unavailable", messages.deliveryUnavailable);
        }

        const maskedDestination = (channel === "email" ? maskEmail(destination) : maskPhone(destination)) ?? null;
        return {
          status: "ok" as const,
          message: channel === "email" ? "I just emailed you a six-digit code." : "I just texted you a six-digit code.",
          sent: true,
          maskedDestination,
          expiresInSeconds: otpTtlSeconds,
        };
      } catch (error) {
        request.log.warn({ err: error }, "otp send unavailable");
        return notSent("service_unavailable", messages.serviceUnavailable);
      }
    });

    app.post("/otp/check", { schema: { body: checkOtpBody, response: { 200: checkOtpResponse } } }, async (request) => {
      const { callId, code } = request.body;
      try {
        // Counting the attempt before comparing makes concurrent guesses share one budget.
        const [challenge] = await deps.twin.query(
          sql`UPDATE calls SET otp_attempts = otp_attempts + 1
              WHERE call_id = ${callId} AND otp_hash IS NOT NULL
              RETURNING otp_hash, otp_expires_at, otp_attempts, now() AS db_now`,
          challengeRow,
        );
        if (!challenge) return notVerified("no_active_code", messages.noActiveCode);

        const submittedHash = hashCode(deps.config.OTP_HASH_SECRET, callId, code);
        const outcome = checkCode(
          { otpHash: challenge.otp_hash, expiresAt: challenge.otp_expires_at, attempts: challenge.otp_attempts },
          submittedHash,
          challenge.db_now,
        );
        if (outcome.result === "expired") return notVerified("expired", messages.expired);
        if (outcome.result === "locked") return notVerified("locked", messages.locked, 0);
        if (outcome.result === "wrong_code") {
          return notVerified("wrong_code", `That code doesn't match. You have ${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? "try" : "tries"} left.`, outcome.attemptsLeft);
        }

        // Only the challenge just compared is spent; one replaced or cleared meanwhile verifies nothing.
        const [spent] = await deps.twin.query(
          sql`UPDATE calls SET verified = TRUE, otp_hash = NULL
              WHERE call_id = ${callId} AND otp_hash = ${submittedHash} RETURNING mc_number`,
          z.object({ mc_number: z.string().nullable() }),
        );
        if (!spent) return notVerified("no_active_code", messages.noActiveCode);
        return {
          status: "ok" as const,
          message: messages.verified,
          verified: true,
          attemptsLeft: null,
          notifiedLoadIds: await notifiedLoadIds(deps, callId, spent.mc_number, request.log),
        };
      } catch (error) {
        request.log.warn({ err: error }, "otp check unavailable");
        return notVerified("service_unavailable", messages.serviceUnavailable);
      }
    });
  };
}
