import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { evaluateOfferBody, evaluateOfferResponse, type EvaluateOfferResponse } from "../contract.ts";
import { dollars, evaluateOffer, type OfferEvaluation } from "../domain/negotiation.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, TwinError, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type OfferRouteDeps = { tms: Pick<TmsClient, "getLoad">; twin: TwinClient };

const messages = {
  notVerified: "I need to verify your carrier before we can talk rates.",
  loadUnavailable: "I'm sorry, that load is no longer available.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  retry: "Sorry, I missed that. Could you tell me your rate one more time?",
  invalid: "I need the load number and your rate in whole dollars to check that.",
  reject: "I'm sorry, I can't get to that number on this load.",
} as const;

function messageFor(evaluation: OfferEvaluation): string {
  if (evaluation.decision === "reject") return messages.reject;
  if (evaluation.decision === "accept") return `${dollars(evaluation.rateToSay)} works for us on this load.`;
  return evaluation.isFinalRound
    ? `${dollars(evaluation.rateToSay)} is the best I can do on this load.`
    : `I can do ${dollars(evaluation.rateToSay)} on this load.`;
}

const noDecision = (status: Exclude<EvaluateOfferResponse["status"], "ok">, message: string): EvaluateOfferResponse => ({
  status,
  message,
  decision: null,
  rateToSay: null,
  round: null,
  isFinalRound: false,
});

const callStateRow = z.object({ verified: z.boolean(), prior_rounds: z.coerce.number().int(), held_elsewhere: z.boolean() });

export function offerRoutes(deps: OfferRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noDecision("invalid_request", messages.invalid)));

    app.post(
      "/offers/evaluate",
      { schema: { body: evaluateOfferBody, response: { 200: evaluateOfferResponse } } },
      async (request) => {
        const { callId, loadId, carrierAsk } = request.body;
        try {
          // The round is counted server-side so a client can never reset the schedule.
          const [call] = await deps.twin.query(
            sql`SELECT c.verified,
                  (SELECT count(*) FROM offers o WHERE o.call_id = c.call_id AND o.load_id = ${loadId}) AS prior_rounds,
                  EXISTS (SELECT 1 FROM holds h WHERE h.load_id = ${loadId} AND h.status <> 'released'
                    AND h.call_id <> c.call_id) AS held_elsewhere
                FROM calls c WHERE c.call_id = ${callId}`,
            callStateRow,
          );
          if (call?.verified !== true) return noDecision("not_verified", messages.notVerified);
          // Another call's hold means the load cannot be sold here, so no rate is quoted for it.
          if (call.held_elsewhere) return noDecision("load_unavailable", messages.loadUnavailable);
          const round = call.prior_rounds + 1;

          const load = await deps.tms.getLoad(loadId);
          if (load.status !== "OPEN") return noDecision("load_unavailable", messages.loadUnavailable);

          const evaluation = evaluateOffer({ postedRate: load.rate, maxBuy: load.maxBuy, carrierAsk, round });
          await deps.twin.query(
            sql`INSERT INTO offers (call_id, load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy)
                VALUES (${callId}, ${loadId}, ${round}, ${carrierAsk}, ${evaluation.decision}, ${evaluation.rateToSay},
                  ${load.rate}, ${load.maxBuy})`,
            z.unknown(),
          );

          return {
            status: "ok" as const,
            message: messageFor(evaluation),
            decision: evaluation.decision,
            rateToSay: evaluation.rateToSay,
            round,
            isFinalRound: evaluation.isFinalRound,
          };
        } catch (error) {
          request.log.warn({ err: error }, "offer evaluation unavailable");
          if (error instanceof TmsBusinessError) return noDecision("load_unavailable", messages.loadUnavailable);
          if (error instanceof TmsUnavailableError) return noDecision("tms_unavailable", messages.tmsUnavailable);
          // A concurrent request took this round; nothing was said for it, so the caller asks again.
          if (error instanceof TwinError && error.isUniqueViolation) return noDecision("retry", messages.retry);
          return noDecision("service_unavailable", messages.serviceUnavailable);
        }
      },
    );
  };
}
