import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { operatorTimeZone } from "../constants.ts";
import { tripEstimateBody, tripEstimateResponse, type TripEstimateResponse, type TripSnapshot } from "../contract.ts";
import { dollars } from "../domain/negotiation.ts";
import type { TripEstimate } from "../domain/trip-estimate.ts";
import type { LoadDetail } from "../infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import type { TripEstimator } from "../infra/trip-estimator.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

type Log = { warn: (details: object, message: string) => void };

export type TripEstimates = Pick<TripEstimator, "estimate">;
export type TripRouteDeps = { tms: Pick<TmsClient, "getLoad">; twin: Pick<TwinClient, "query">; trips: TripEstimates };

const offsetFormat = new Intl.DateTimeFormat("en-US", { timeZone: operatorTimeZone, timeZoneName: "longOffset" });

// The desk zone's UTC offset at an instant: "GMT-05:00" is -5 h, a bare "GMT" is 0.
function deskOffsetMs(at: number): number {
  const name = offsetFormat.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = /([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

// The TMS wall clock (YYYYMMDDHHMMSS) read in the desk's zone, the same reading tripSql gives
// pickup_at with `AT TIME ZONE`. The offset is looked up twice so a date across a DST change lands right.
export function tmsWallClockToDate(wire: string): Date {
  const asUtc = Date.UTC(
    Number(wire.slice(0, 4)),
    Number(wire.slice(4, 6)) - 1,
    Number(wire.slice(6, 8)),
    Number(wire.slice(8, 10)),
    Number(wire.slice(10, 12)),
    Number(wire.slice(12, 14)),
  );
  return new Date(asUtc - deskOffsetMs(asUtc - deskOffsetMs(asUtc)));
}

// Never throws: a load without an estimate is still pitched, held and quoted.
export async function estimateLoadTrip(trips: TripEstimates, load: LoadDetail, rate: number, log: Log): Promise<TripEstimate | null> {
  try {
    return await trips.estimate(
      {
        origin: { zip: load.origZip, state: load.origState },
        destination: { zip: load.destZip, state: load.destState },
        miles: load.miles,
        pickupAt: tmsWallClockToDate(load.pickupDateTime),
        deliveryAt: tmsWallClockToDate(load.deliveryDateTime),
        rate,
      },
      log,
    );
  } catch (error) {
    log.warn({ err: error, loadId: load.loadId }, "trip estimate unavailable");
    return null;
  }
}

// Picks fields explicitly: this shape is spoken to the carrier and stored on the hold.
export function tripSnapshotFor(rate: number, estimate: TripEstimate): TripSnapshot {
  return {
    rate,
    dieselUsd: estimate.dieselUsd,
    tollsUsd: estimate.tollsUsd,
    carrierNetUsd: estimate.carrierNetUsd,
    feasibility: estimate.feasibility,
    legalEtaAt: estimate.legalEtaAt.toISOString(),
    netPerHour: estimate.netPerHour,
  };
}

const messages = {
  notVerified: "I need to verify your carrier before I can go over trip costs.",
  loadUnavailable: "I'm sorry, that load is no longer available.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  estimateUnavailable: "I can't work out the fuel and tolls on that load right now.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalid: "I need the load number to work out that trip.",
} as const;

const feasibilityNote = {
  solo: "",
  team: " That delivery window needs a team.",
  impossible: " That delivery window is too tight to make legally.",
} as const;

function messageFor(trip: TripSnapshot): string {
  return (
    `At ${dollars(trip.rate)}, after about ${dollars(trip.dieselUsd)} in diesel and about ${dollars(trip.tollsUsd)} in tolls, ` +
    `you'd keep about ${dollars(trip.carrierNetUsd)}.${feasibilityNote[trip.feasibility]}`
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

// The rate being talked about: our latest accept or counter on this load, else nothing yet.
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
                    AND o.decision IN ('accept', 'counter') ORDER BY o.round DESC LIMIT 1) AS rate_to_say
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
          return { status: "ok" as const, message: messageFor(trip), ...trip };
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
