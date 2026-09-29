import type { FastifyPluginAsync } from "fastify";

// Public and dependency free: Render health checks and the keep-alive ping hit it, the TMS never does.
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/healthz", async () => ({ status: "ok" }));
};
