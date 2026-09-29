import type { FastifyPluginAsync } from "fastify";
import { hasZodFastifySchemaValidationErrors, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { loadsPitchedPerSearch } from "../constants.ts";
import {
  searchLoadsBody,
  searchLoadsResponse,
  type PitchedLoad,
  type SearchLoadsBody,
  type SearchLoadsResponse,
} from "../contract.ts";
import type { LoadDetail, LoadQueryFilters } from "../infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../infra/tms/errors.ts";
import type { TmsClient } from "../infra/tms/tms-client.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";

export type LoadRouteDeps = { tms: Pick<TmsClient, "queryLoads" | "getLoad">; twin: TwinClient };

const messages = {
  notVerified: "I need to verify your carrier before I can go over loads with you.",
  noLoads: "I don't have any open loads on that lane right now.",
  tmsUnavailable: "I can't reach our load board right now. Please give me a moment and try again.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
  invalid: "I need at least a pickup city, state or zip and an equipment type to search for loads.",
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

// Picks fields explicitly so the max buy on LoadDetail can never reach a response.
function toPitchedLoad(load: LoadDetail): PitchedLoad {
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
  };
}

export function loadRoutes(deps: LoadRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler((error, _request, reply) => {
      if (hasZodFastifySchemaValidationErrors(error)) {
        return reply.code(200).send(noLoads("invalid_request", messages.invalid));
      }
      throw error;
    });

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
          const shortlist = summaries.filter((load) => isOpen(load.status)).slice(0, loadsPitchedPerSearch);
          // A load that vanished or changed status since the query is dropped, not pitched.
          const details = await Promise.all(
            shortlist.map((load) =>
              deps.tms.getLoad(load.loadId).catch((error: unknown) => {
                if (error instanceof TmsBusinessError) return null;
                throw error;
              }),
            ),
          );
          const loads = details.filter((load): load is LoadDetail => load !== null && isOpen(load.status)).map(toPitchedLoad);
          if (loads.length === 0) return noLoads("no_loads", messages.noLoads);
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
