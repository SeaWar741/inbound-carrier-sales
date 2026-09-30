import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { verifyCarrierBody, verifyCarrierResponse, type VerifyCarrierResponse } from "../contract.ts";
import { maskEmail, maskPhone, verifyCarrier, type Verification } from "../domain/verification.ts";
import type { CensusClient, CensusContact } from "../infra/census-client.ts";
import type { FmcsaAuthority, FmcsaCarrier, FmcsaClient } from "../infra/fmcsa-client.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type CarrierRouteDeps = { fmcsa: FmcsaClient; census: CensusClient; twin: TwinClient };

const messages = {
  ok: "The carrier is verified and eligible to book loads with us.",
  notEligible: "I'm sorry, based on FMCSA records this carrier isn't eligible to book loads with us right now.",
  notFound: "I couldn't find a carrier with that number. Could you read it to me again?",
  multiple: "That number matches more than one carrier, so a team member will need to review it.",
  review: "I couldn't confirm everything automatically, so a team member will need to review this carrier.",
  unavailable: "I can't reach the carrier records right now. Please try again in a moment.",
  invalid: "I need either an MC number or a DOT number, digits only, to verify the carrier.",
} as const;

function messageFor(verification: Verification): string {
  if (verification.status === "ok") return messages.ok;
  if (verification.status === "not_eligible") return messages.notEligible;
  if (verification.reasons.includes("carrier_not_found")) return messages.notFound;
  if (verification.reasons.includes("multiple_carriers_matched")) return messages.multiple;
  return messages.review;
}

const noResult = (status: "verification_unavailable" | "invalid_request", message: string): VerifyCarrierResponse => ({
  status,
  message,
  eligible: false,
  reasons: [],
  carrierName: null,
  dotNumber: null,
  mcNumber: null,
  maskedContact: {},
  riskFlags: [],
});

// A DOT lookup learns the MC only when the carrier holds exactly one MC docket.
function soleMcDocket(authorities: FmcsaAuthority[]): string | null {
  const dockets = new Set(authorities.filter((a) => a.prefix === "MC" && a.docketNumber != null).map((a) => a.docketNumber));
  const [only] = dockets;
  return dockets.size === 1 && only != null ? String(only) : null;
}

// SMS reaches a cell phone, so it wins over the business line when both are on file.
function maskContact(contact: CensusContact | null | undefined): VerifyCarrierResponse["maskedContact"] {
  const email = contact?.email ? maskEmail(contact.email) : undefined;
  const phoneNumber = contact?.cellPhone ?? contact?.phone;
  const phone = phoneNumber ? maskPhone(phoneNumber) : undefined;
  return { ...(email && { email }), ...(phone && { phone }) };
}

export function carrierRoutes(deps: CarrierRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noResult("invalid_request", messages.invalid)));

    app.post(
      "/carriers/verify",
      { schema: { body: verifyCarrierBody, response: { 200: verifyCarrierResponse } } },
      async (request) => {
        const { callId, mcNumber, dotNumber } = request.body;
        try {
          let candidates: FmcsaCarrier[] = [];
          if (mcNumber !== undefined) candidates = await deps.fmcsa.carriersByDocket(mcNumber);
          else if (dotNumber !== undefined) {
            const found = await deps.fmcsa.carrierByDot(dotNumber);
            if (found) candidates = [found];
          }
          // Never pick the first of several records: the wrong one could be the eligible one.
          const carrier = candidates.length === 1 ? candidates[0] : undefined;

          let verification: Verification;
          let contact: CensusContact | null | undefined = null;
          let resolvedDot = dotNumber ?? null;
          let resolvedMc = mcNumber ?? null;
          if (carrier) {
            resolvedDot = String(carrier.dotNumber);
            const [authorities, outOfService, censusContact] = await Promise.all([
              deps.fmcsa.authorities(resolvedDot),
              deps.fmcsa.outOfServiceOrders(resolvedDot),
              // The contact only feeds masking and risk flags, so a census outage leaves it unknown.
              deps.census.contactByDot(resolvedDot).catch((error: unknown) => {
                request.log.warn({ err: error }, "census contact unavailable");
                return undefined;
              }),
            ]);
            contact = censusContact;
            resolvedMc ??= soleMcDocket(authorities);
            verification = verifyCarrier({ match: "one", carrier, authorities, outOfService, contact, now: new Date() });
          } else {
            verification = verifyCarrier({ match: candidates.length === 0 ? "none" : "multiple" });
          }

          const carrierName = carrier?.legalName ?? carrier?.dbaName ?? null;
          await deps.twin.query(
            // A new lookup resets identity: the OTP must be passed again for whatever carrier this is.
            sql`INSERT INTO calls (call_id, dot_number, mc_number, eligible, verified, carrier_name)
                VALUES (${callId}, ${resolvedDot}, ${resolvedMc}, ${verification.eligible}, FALSE, ${carrierName})
                ON CONFLICT (call_id) DO UPDATE SET dot_number = EXCLUDED.dot_number,
                  mc_number = EXCLUDED.mc_number, eligible = EXCLUDED.eligible, verified = FALSE,
                  carrier_name = EXCLUDED.carrier_name, otp_hash = NULL`,
            z.unknown(),
          );

          return {
            status: verification.status,
            message: messageFor(verification),
            eligible: verification.eligible,
            reasons: verification.reasons,
            carrierName,
            dotNumber: resolvedDot,
            mcNumber: resolvedMc,
            maskedContact: maskContact(contact),
            riskFlags: verification.riskFlags,
          };
        } catch (error) {
          request.log.warn({ err: error }, "carrier verification unavailable");
          return noResult("verification_unavailable", messages.unavailable);
        }
      },
    );
  };
}
