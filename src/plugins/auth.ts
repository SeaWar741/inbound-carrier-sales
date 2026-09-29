import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export type Principal = "agent" | "operator";

const digest = (value: string) => createHash("sha256").update(value).digest();

// Hashing first makes the comparison constant time regardless of input length.
export function keyMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

// onRequest hook for an encapsulated route plugin: only the principal owning `expectedKey` passes.
export function requireApiKey(expectedKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const presented = request.headers["x-api-key"];
    if (typeof presented !== "string" || !keyMatches(presented, expectedKey)) {
      return reply.code(401).send({ status: "unauthorized", message: "Missing or invalid API key." });
    }
  };
}
