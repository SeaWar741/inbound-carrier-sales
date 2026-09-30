import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loadsPitchedPerSearch, searchCandidateFactor } from "../constants.ts";
import {
  searchLoadsBody,
  searchLoadsResponse,
  type PitchedLoad,
  type SearchLoadsBody,
  type SearchLoadsResponse,
} from "../contract.ts";
import type { Feasibility } from "../domain/trip-estimate.ts";
import type { LoadDetail, LoadQueryFilters } from "../infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { estimateLoadTrip, type TripEstimates } from "../infra/trip-estimator.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type LoadRouteDeps = { tms: Pick<TmsClient, "queryLoads" | "getLoad">; twin: TwinClient; trips: TripEstimates };

const messages = {
  notVerified: "I need to verify your carrier before I can go over loads with you.",
  noLoads: "I don't have any open loads on that lane right now.",
  windowsTooTight: "The loads I have on that lane right now have delivery windows too tight to run legally.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalid: "I need at least a pickup city, state or zip to search for loads.",
} as const;

const found = (count: number) => (count === 1 ? "I found one open load that fits." : `I found ${count} open loads that fit.`);

const noLoads = (status: Exclude<SearchLoadsResponse["status"], "ok">, message: string): SearchLoadsResponse => ({
  status,
  message,
  loads: [],
});

// Only OPEN is offered; any other or future status is treated as not bookable.
const isOpen = (status: string) => status === "OPEN";

async function isCallVerified(twin: TwinClient, callId: string): Promise<boolean> {
  const rows = await twin.query(sql`SELECT verified FROM calls WHERE call_id = ${callId}`, z.object({ verified: z.boolean() }));
  return rows[0]?.verified === true;
}

// One query for the whole list: a load another call is holding is not pitched.
async function loadsHeldByOtherCalls(twin: TwinClient, callId: string, loadIds: string[]): Promise<Set<string>> {
  if (loadIds.length === 0) return new Set();
  const rows = await twin.query(
    sql`SELECT load_id FROM holds WHERE load_id IN (${loadIds}) AND status <> 'released' AND call_id <> ${callId}`,
    z.object({ load_id: z.string() }),
  );
  return new Set(rows.map((row) => row.load_id));
}

// YYYYMMDDHHMMSS carries no timezone on the wire, so none is invented here.
const readableDateTime = (wire: string) =>
  `${wire.slice(0, 4)}-${wire.slice(4, 6)}-${wire.slice(6, 8)} ${wire.slice(8, 10)}:${wire.slice(10, 12)}`;

function toFilters(body: SearchLoadsBody): LoadQueryFilters {
  return {
    origCity: body.origin.city,
    origState: body.origin.state,
    origZip: body.origin.zip,
    destCity: body.destination?.city,
    destState: body.destination?.state,
    destZip: body.destination?.zip,
    equipmentType: body.equipmentType,
    pickupDate: body.pickupDate,
  };
}

// What the carrier asked for and what the board answered, for the operator's demand radar. Fire and forget:
// the answer to the carrier never waits on it, and only a search that reached the board is recorded, so an
// outage never reads as unmet demand.
function recordSearch(twin: TwinClient, body: SearchLoadsBody, results: number, droppedImpossible: number, log: FastifyBaseLogger) {
  const { origin, destination } = body;
  void twin
    .query(
      sql`INSERT INTO load_searches (call_id, origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, pickup_date, results, dropped_impossible)
          VALUES (${body.callId}, ${origin.city ?? null}, ${origin.state ?? null}, ${origin.zip ?? null}, ${destination?.city ?? null}, ${destination?.state ?? null}, ${destination?.zip ?? null}, ${body.equipmentType ?? null}, ${body.pickupDate ?? null}, ${results}, ${droppedImpossible})`,
      z.unknown(),
    )
    .catch((error: unknown) => log.warn({ err: error }, "load search not recorded"));
}

// Picks fields explicitly so the max buy on LoadDetail can never reach a response.
function toPitchedLoad(load: LoadDetail, feasibility: Feasibility | null): PitchedLoad {
  return {
    loadId: load.loadId,
    origin: `${load.origCity}, ${load.origState} ${load.origZip}`,
    destination: `${load.destCity}, ${load.destState} ${load.destZip}`,
    pickupDateTime: readableDateTime(load.pickupDateTime),
    deliveryDateTime: readableDateTime(load.deliveryDateTime),
    equipmentType: load.equipmentType,
    loadboardRate: load.rate,
    miles: load.miles,
    weight: load.weight,
    commodity: load.commodity,
    pieces: load.pieces,
    dims: load.dims,
    notes: load.notes,
    feasibility,
  };
}

export function loadRoutes(deps: LoadRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => noLoads("invalid_request", messages.invalid)));

    app.post(
      "/loads/search",
      { schema: { body: searchLoadsBody, response: { 200: searchLoadsResponse } } },
      async (request) => {
        try {
          if (!(await isCallVerified(deps.twin, request.body.callId))) {
            return noLoads("not_verified", messages.notVerified);
          }
        } catch (error) {
          request.log.warn({ err: error }, "call lookup unavailable");
          return noLoads("service_unavailable", messages.serviceUnavailable);
        }

        try {
          const summaries = await deps.tms.queryLoads(toFilters(request.body));
          const open = summaries.filter((load) => isOpen(load.status));
          const heldElsewhere = await loadsHeldByOtherCalls(deps.twin, request.body.callId, open.map((load) => load.loadId));
          // More candidates than the pitch, so loads nobody can deliver on time can be dropped without thinning it.
          const shortlist = open
            .filter((load) => !heldElsewhere.has(load.loadId))
            .slice(0, loadsPitchedPerSearch * searchCandidateFactor);
          // A load that vanished, changed status or could not be read since the query is dropped, not pitched.
          const details = await Promise.all(
            shortlist.map((load) =>
              deps.tms.getLoad(load.loadId).catch((error: unknown) => {
                if (error instanceof TmsBusinessError) return "gone" as const;
                if (error instanceof TmsUnavailableError) {
                  request.log.warn({ err: error, loadId: load.loadId }, "load detail unavailable");
                  return "unavailable" as const;
                }
                throw error;
              }),
            ),
          );
          const candidates = details.filter((load): load is LoadDetail => typeof load === "object" && isOpen(load.status));
          // At the posted rate, since nothing is negotiated yet. A load no crew can deliver on time is never
          // pitched; a failed estimate keeps the load with feasibility null, so a vendor outage never empties the board.
          const estimates = await Promise.all(candidates.map((load) => estimateLoadTrip(deps.trips, load, load.rate, request.log)));
          const deliverable = candidates
            .map((load, i) => toPitchedLoad(load, estimates[i]?.feasibility ?? null))
            .filter((load) => load.feasibility !== "impossible");
          const loads = deliverable.slice(0, loadsPitchedPerSearch);
          const noneRead = details.every((load) => typeof load !== "object");
          if (noneRead && details.includes("unavailable")) {
            return noLoads("tms_unavailable", messages.tmsUnavailable);
          }
          recordSearch(deps.twin, request.body, loads.length, candidates.length - deliverable.length, request.log);
          if (loads.length === 0) {
            return noLoads("no_loads", candidates.length > 0 ? messages.windowsTooTight : messages.noLoads);
          }
          return { status: "ok" as const, message: found(loads.length), loads };
        } catch (error) {
          request.log.warn({ err: error }, "load search unavailable");
          if (error instanceof TmsUnavailableError || error instanceof TmsBusinessError) {
            return noLoads("tms_unavailable", messages.tmsUnavailable);
          }
          return noLoads("service_unavailable", messages.serviceUnavailable);
        }
      },
    );
  };
}
