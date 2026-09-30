import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requestHumanBody, requestHumanResponse, type RequestHumanResponse } from "../contract.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";
import { maxSummaryLength } from "../plugins/call-events.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

export type HandoffRouteDeps = { twin: Pick<TwinClient, "query"> };

const messages = {
  transferring: "Let me get a senior rep on the line; they will have everything we covered.",
  unavailable: "I couldn't reach a senior rep just now. Let me keep helping you in the meantime.",
  invalid: "I didn't catch that. Do you want me to get a senior rep on the line?",
} as const;

// The call_events row is how the operator wall learns a rep is wanted, so it is awaited:
// the agent only promises a rep once the request is recorded. The call-events hook skips
// this route so the row is written exactly once.
export const handoffRoutes =
  (deps: HandoffRouteDeps): FastifyPluginAsync =>
  async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();

    app.setErrorHandler(
      invalidRequestHandler((): RequestHumanResponse => ({ status: "invalid_request", message: messages.invalid })),
    );

    app.post(
      "/calls/request-human",
      { schema: { body: requestHumanBody, response: { 200: requestHumanResponse } } },
      async (request): Promise<RequestHumanResponse> => {
        const { callId, reason } = request.body;
        const summary = (reason ? `Carrier asked for a human: ${reason}` : "Carrier asked for a human").slice(0, maxSummaryLength);
        try {
          await deps.twin.query(
            sql`INSERT INTO call_events (call_id, tool, summary, status) VALUES (${callId}, 'request_human', ${summary}, 'transferring')`,
            z.unknown(),
          );
        } catch (error) {
          request.log.warn({ err: error }, "human handoff not recorded");
          return { status: "service_unavailable", message: messages.unavailable };
        }
        return { status: "transferring", message: messages.transferring };
      },
    );
  };
