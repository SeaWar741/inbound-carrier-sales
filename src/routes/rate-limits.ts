import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { HitStore } from "../infra/shared-counter.ts";

// The tower's rate-limit hits, counted in Twin with the adapter's own so every tower instance shares them.
const hitBody = z.strictObject({
  key: z.string().min(1).max(200),
  windowStartSeconds: z.number().int().min(0),
  hits: z.number().int().min(1).max(100_000),
});

export function rateLimitRoutes(deps: { hits: HitStore }): FastifyPluginAsync {
  return async (plugin) => {
    const app = plugin.withTypeProvider<ZodTypeProvider>();
    app.post("/operator/rate-limits/hit", { schema: { body: hitBody } }, async (request, reply) => {
      try {
        return { hits: await deps.hits(`tower:${request.body.key}`, request.body.windowStartSeconds, request.body.hits) };
      } catch (error) {
        request.log.warn({ err: error }, "rate-limit hit not counted");
        return reply.code(503).send({ status: "service_unavailable", message: "Rate-limit store unavailable." });
      }
    });
  };
}
