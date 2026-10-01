import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { saveCapacityBody, saveCapacityResponse, type SaveCapacityResponse } from "../contract.ts";
import { operatorTimeZone } from "../constants.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type CapacityRouteDeps = { twin: Pick<TwinClient, "query"> };

// Carrier-facing and never a promise: a saved truck only means we may send a load later.
const saveMessages = {
  saved: "Got it, your truck is on file. If a load opens up near there we'll send you the details.",
  notVerified: "I need to verify your carrier before I can keep your truck on file.",
  noConsent: "No problem, I won't keep your truck on file.",
  pastDate: "That date has already passed. When does the truck free up?",
  invalid: "I need the city, the state and the day your truck frees up to keep it on file.",
  serviceUnavailable: "I'm having trouble on my end right now. Please give me a moment and try again.",
} as const;

const reply = (status: SaveCapacityResponse["status"], message: string): SaveCapacityResponse => ({ status, message });

// The desk's calendar day as YYYY-MM-DD; en-CA formats dates in that order.
const deskToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: operatorTimeZone }).format(now);

const callRow = z.object({ verified: z.boolean(), mc_number: z.string().nullable() });

export function capacityRoutes(deps: CapacityRouteDeps): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(invalidRequestHandler(() => reply("invalid_request", saveMessages.invalid)));

    app.post("/capacity", { schema: { body: saveCapacityBody, response: { 200: saveCapacityResponse } } }, async (request) => {
      const { callId, city, state, freeDate, equipmentType, preferredDestinationState, consent } = request.body;
      try {
        const [call] = await deps.twin.query(sql`SELECT verified, mc_number FROM calls WHERE call_id = ${callId}`, callRow);
        if (call?.verified !== true || call.mc_number === null) return reply("not_verified", saveMessages.notVerified);
        if (!consent) return reply("no_consent", saveMessages.noConsent);
        // ISO dates compare as strings.
        if (freeDate < deskToday(new Date())) return reply("invalid_request", saveMessages.pastDate);

        // A second save on the same call corrects the truck; a load already sent for it stays recorded.
        await deps.twin.query(
          sql`INSERT INTO truck_capacity (call_id, mc_number, city, state, equipment, free_date, preferred_destination_state)
              VALUES (${callId}, ${call.mc_number}, ${city}, ${state}, ${equipmentType ?? null}, ${freeDate}, ${preferredDestinationState ?? null})
              ON CONFLICT (call_id) DO UPDATE SET city = EXCLUDED.city, state = EXCLUDED.state, equipment = EXCLUDED.equipment,
                free_date = EXCLUDED.free_date, preferred_destination_state = EXCLUDED.preferred_destination_state`,
          z.unknown(),
        );
        return reply("ok", saveMessages.saved);
      } catch (error) {
        request.log.warn({ err: error }, "capacity not saved");
        return reply("service_unavailable", saveMessages.serviceUnavailable);
      }
    });
  };
}
