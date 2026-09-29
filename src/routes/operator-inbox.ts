import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { operatorLoadsResponse, operatorWallUnavailableResponse, type OperatorLoad } from "../contract.ts";
import { tripProgress, tripSql, tripStatuses } from "../domain/trip.ts";
import { sql, type SqlStatement, type TwinClient } from "../infra/twin-client.ts";
import { laneOf } from "./operator.ts";

export type OperatorInboxDeps = { twin: Pick<TwinClient, "query"> };

// Booked holds with the lane of their load's latest offer that has one; holds whose load never had
// a lane stored are skipped, which also keeps tripSql away from null pickups. The window keeps
// trips that arrived in the last day and pickups up to a week out; 500 is the dashboard's cap.
export function loadsQuery(): SqlStatement {
  const text = sql`WITH lane AS (
      SELECT DISTINCT ON (h.hold_id) h.hold_id, h.load_id, h.call_id, h.agreed_rate,
        COALESCE(h.mc_number, c.mc_number) AS mc_number, c.carrier_name,
        o.origin_city, o.origin_state, o.origin_zip, o.destination_city, o.destination_state, o.destination_zip,
        o.equipment, o.miles, o.pickup_at
      FROM holds h
      JOIN offers o ON o.load_id = h.load_id
      LEFT JOIN calls c ON c.call_id = h.call_id
      WHERE h.status IN ('booked', 'booked_unconfirmed')
        AND o.origin_city IS NOT NULL AND o.origin_state IS NOT NULL AND o.origin_zip IS NOT NULL
        AND o.destination_city IS NOT NULL AND o.destination_state IS NOT NULL AND o.destination_zip IS NOT NULL
        AND o.equipment IS NOT NULL AND o.miles IS NOT NULL AND o.pickup_at IS NOT NULL
      ORDER BY h.hold_id, o.created_at DESC
    )
    SELECT lane.*, trip.pickup_ts, trip.eta_ts, trip.trip_status
    FROM lane `.text + tripSql.text + sql`
    WHERE trip.eta_ts >= now() - interval '24 hours' AND trip.pickup_ts <= now() + interval '7 days'
    ORDER BY trip.pickup_ts
    LIMIT 500`.text;
  return { text };
}

// Twin returns int8 as strings and timestamptz as ISO strings with an offset.
export const loadRow = z.object({
  hold_id: z.string(),
  load_id: z.string(),
  call_id: z.string(),
  agreed_rate: z.coerce.number(),
  mc_number: z.string().nullable(),
  carrier_name: z.string().nullable(),
  origin_city: z.string(),
  origin_state: z.string(),
  origin_zip: z.string(),
  destination_city: z.string(),
  destination_state: z.string(),
  destination_zip: z.string(),
  equipment: z.string(),
  miles: z.coerce.number().int(),
  pickup_at: z.string(),
  pickup_ts: z.coerce.date(),
  eta_ts: z.coerce.date(),
  trip_status: z.enum(tripStatuses),
});
type LoadRow = z.output<typeof loadRow>;

function toOperatorLoad(row: LoadRow, now: Date): OperatorLoad | null {
  const lane = laneOf(row);
  if (!lane) return null;
  return {
    holdId: row.hold_id,
    loadId: row.load_id,
    callId: row.call_id,
    mcNumber: row.mc_number,
    carrierName: row.carrier_name,
    agreedRate: row.agreed_rate,
    lane,
    pickupAt: row.pickup_ts.toISOString(),
    etaAt: row.eta_ts.toISOString(),
    status: row.trip_status,
    progress: tripProgress(row.pickup_ts, row.eta_ts, now),
  };
}

export function operatorInboxRoutes(deps: OperatorInboxDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.get(
      "/operator/loads",
      { schema: { response: { 200: operatorLoadsResponse, 503: operatorWallUnavailableResponse } } },
      async (request, reply) => {
        try {
          const rows = await deps.twin.query(loadsQuery(), loadRow);
          const now = new Date();
          return { status: "ok" as const, loads: rows.flatMap((row) => toOperatorLoad(row, now) ?? []) };
        } catch (error) {
          request.log.warn({ err: error }, "operator loads unavailable");
          return reply.code(503).send({ status: "service_unavailable", message: "The load data is unavailable right now. Retry shortly." });
        }
      },
    );
  };
}
