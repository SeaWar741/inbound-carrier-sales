import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

// The voice agent speaks every answer, so a malformed request is a 200 with a typed body it can read back.
export function invalidRequestHandler(bodyFor: (request: FastifyRequest) => unknown) {
  return (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (hasZodFastifySchemaValidationErrors(error)) return reply.code(200).send(bodyFor(request));
    throw error;
  };
}
