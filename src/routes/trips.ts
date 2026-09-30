import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { tollsSpokenFloorUsd } from "../constants.ts";
import { tripEstimateBody, tripEstimateResponse, type TripEstimateResponse, type TripSnapshot } from "../contract.ts";
import { dollars } from "../domain/negotiation.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { estimateLoadTrip, tripSnapshotFor, type TripEstimates } from "../infra/trip-estimator.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type TripRouteDeps = { tms: Pick<TmsClient, "getLoad">; twin: Pick<TwinClient, "query">; trips: TripEstimates };

const messages = {
  notVerified: "I need to verify your carrier before I can go over trip costs.",
  loadUnavailable: "I'm sorry, that load is no longer available.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  estimateUnavailable: "I can't work out the fuel and tolls on that load right now.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalid: "I need the load number to work out that trip.",
} as const;

// Impossible is only past the late tolerance, so the rounded hours are always plural.
function feasibilityNote(trip: TripSnapshot): string {
  if (trip.feasibility === "solo") return "";
  if (trip.feasibility === "team") return " That delivery window needs a team.";
  return (
    " That delivery window is too tight to make legally: it would land about " +
    `${Math.round(trip.lateHours)} hours after the delivery appointment, even running team.`
  );
}

function messageFor(trip: TripSnapshot): string {
  const tolls = trip.tollsUsd < tollsSpokenFloorUsd ? "next to nothing in tolls" : `about ${dollars(trip.tollsUsd)} in tolls`;
  return (
    `At ${dollars(trip.rate)}, after about ${dollars(trip.dieselUsd)} in diesel and ${tolls}, ` +
    `you'd keep about ${dollars(trip.carrierNetUsd)}.${feasibilityNote(trip)}`
  );
}

const noEstimate = (status: Exclude<TripEstimateResponse["status"], "ok">, message: string): TripEstimateResponse => ({
  status,
  message,
  rate: null,
  dieselUsd: null,
  tollsUsd: null,
  carrierNetUsd: null,
  feasibility: null,
  legalEtaAt: null,
  netPerHour: null,
});

// The rate on the table is our latest round on this load, as create_hold reads it. A reject says no
// rate, so the posted rate stands, as it does before any offer.
const callRateRow = z.object({ verified: z.boolean(), rate_to_say: z.coerce.number().int().nullable() });

export function tripRoutes(deps: TripRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noEstimate("invalid_request", messages.invalid)));

    app.post(
      "/trips/estimate",
      { schema: { body: tripEstimateBody, response: { 200: tripEstimateResponse } } },
      async (request) => {
        const { callId, loadId } = request.body;
        try {
          const [call] = await deps.twin.query(
            sql`SELECT c.verified,
                  (SELECT o.rate_to_say FROM offers o WHERE o.call_id = c.call_id AND o.load_id = ${loadId}
                    ORDER BY o.round DESC LIMIT 1) AS rate_to_say
                FROM calls c WHERE c.call_id = ${callId}`,
            callRateRow,
          );
          if (call?.verified !== true) return noEstimate("not_verified", messages.notVerified);

          const load = await deps.tms.getLoad(loadId);
          if (load.status !== "OPEN") return noEstimate("load_unavailable", messages.loadUnavailable);

          const rate = call.rate_to_say ?? load.rate;
          const estimate = await estimateLoadTrip(deps.trips, load, rate, request.log);
          if (!estimate) return noEstimate("estimate_unavailable", messages.estimateUnavailable);

          const trip = tripSnapshotFor(rate, estimate);
          return {
            status: "ok" as const,
            message: messageFor(trip),
            rate: trip.rate,
            dieselUsd: trip.dieselUsd,
            tollsUsd: trip.tollsUsd,
            carrierNetUsd: trip.carrierNetUsd,
            feasibility: trip.feasibility,
            legalEtaAt: trip.legalEtaAt,
            netPerHour: trip.netPerHour,
          };
        } catch (error) {
          request.log.warn({ err: error }, "trip estimate unavailable");
          if (error instanceof TmsBusinessError) return noEstimate("load_unavailable", messages.loadUnavailable);
          if (error instanceof TmsUnavailableError) return noEstimate("tms_unavailable", messages.tmsUnavailable);
          return noEstimate("service_unavailable", messages.serviceUnavailable);
        }
      },
    );
  };
}
