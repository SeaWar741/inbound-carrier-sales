import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { requestHumanBody, requestHumanResponse, type RequestHumanResponse } from "../contract.ts";
import { invalidRequestHandler } from "../plugins/invalid-request.ts";

const messages = {
  transferring: "Let me get a senior rep on the line; they will have everything we covered.",
  invalid: "I couldn't start the transfer just now. Let me keep helping you in the meantime.",
} as const;

// Writes nothing itself: the call-events hook records the request so the operator wall shows it.
export const handoffRoutes: FastifyPluginAsync = async (plugin) => {
  const app = plugin.withTypeProvider<ZodTypeProvider>();

  app.setErrorHandler(
    invalidRequestHandler((): RequestHumanResponse => ({ status: "invalid_request", message: messages.invalid })),
  );

  app.post(
    "/calls/request-human",
    { schema: { body: requestHumanBody, response: { 200: requestHumanResponse } } },
    async (): Promise<RequestHumanResponse> => ({ status: "transferring", message: messages.transferring }),
  );
};
