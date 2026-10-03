import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError, type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { loadConfig, type Config } from "./config.ts";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { CensusClient } from "./infra/census-client.ts";
import { FmcsaClient } from "./infra/fmcsa-client.ts";
import { OtpDeliveryClient } from "./infra/otp-delivery-client.ts";
import { TmsClient } from "./infra/tms/tms-client.ts";
import { TmsHealthRecorder } from "./infra/tms/tms-health.ts";
import { TripEstimator } from "./infra/trip-estimator.ts";
import { SharedCounter, twinHitStore, type HitStore } from "./infra/shared-counter.ts";
import { TwinClient } from "./infra/twin-client.ts";
import { keyMatches, requireApiKey } from "./plugins/auth.ts";
import { recordCallEvents, type CallEventDeps } from "./plugins/call-events.ts";
import { capacityRoutes, operatorCapacityRoutes } from "./routes/capacity.ts";
import { carrierRoutes } from "./routes/carriers.ts";
import { handoffRoutes } from "./routes/handoff.ts";
import { healthRoutes } from "./routes/health.ts";
import { confirmHoldRoutes, holdRoutes, releaseHoldRoutes } from "./routes/holds.ts";
import { loadRoutes } from "./routes/loads.ts";
import { offerRoutes } from "./routes/offers.ts";
import { operatorInboxRoutes } from "./routes/operator-inbox.ts";
import { operatorNetworkRoutes } from "./routes/operator-network.ts";
import { operatorWallRoutes } from "./routes/operator.ts";
import { otpRoutes } from "./routes/otp.ts";
import { rateLimitRoutes } from "./routes/rate-limits.ts";
import { tripRoutes } from "./routes/trips.ts";

export type RouteSets = {
  agentRoutes: FastifyPluginAsync[];
  operatorRoutes: FastifyPluginAsync[];
};

function principalOf(presented: unknown, config: Config): "agent" | "operator" | null {
  if (typeof presented !== "string") return null;
  if (keyMatches(presented, config.AGENT_API_KEY)) return "agent";
  if (keyMatches(presented, config.OPERATOR_API_KEY)) return "operator";
  return null;
}

// Call events are recorded only when a Twin is given, so route tests can leave them out.
// Adapts SharedCounter to @fastify/rate-limit's store contract: incr answers at once, Twin is written behind.
function sharedStore(counter: SharedCounter) {
  return class {
    incr(key: string, callback: (error: Error | null, result: { current: number; ttl: number }) => void, timeWindow: number, max: number) {
      const { count, resetMs } = counter.take(`adapter:${key}`, max, timeWindow);
      callback(null, { current: count, ttl: resetMs });
    }
    child() {
      return this;
    }
  };
}

export function buildServer(config: Config, routes: RouteSets, callEvents?: CallEventDeps, hitStore?: HitStore) {
  const app = Fastify({
    logger: { redact: ["req.headers[\"x-api-key\"]", "req.headers.authorization"] },
    // Every body is a small JSON object; a hold confirm, the slowest call, answers within 30 s.
    bodyLimit: 64 * 1024,
    requestTimeout: 60_000,
    // Render's proxy is the one hop in front, so request.ip is the address it saw.
    trustProxy: (_address: string, hop: number) => hop === 0,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-content-type-options", "nosniff").header("cache-control", "no-store");
  });
  // A 5xx message can carry a Twin or TMS error (SQL text included), so callers only get a generic body.
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      return reply.code(statusCode).send({ status: statusCode === 429 ? "too_many_requests" : "invalid_request", message: error.message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ status: "internal_error", message: "Unexpected error." });
  });

  // Per principal and minute: the agent serves every concurrent call, the operator is the tower polling.
  // A request with no valid key is limited by address, so guessing keys stays slow.
  // A root hook, so it runs before each scope's key check and a key guesser is limited too.
  // Counts are shared through Twin when a hit store is given; route tests leave it out and count locally.
  const counter = new SharedCounter(hitStore ?? (() => Promise.reject(new Error("no shared store"))));
  app.register(rateLimit, { global: false, store: sharedStore(counter) });
  app.after(() => {
    app.addHook(
      "onRequest",
      app.rateLimit({
        timeWindow: 60_000,
        keyGenerator: (request) => principalOf(request.headers["x-api-key"], config) ?? request.ip,
        // The operator budget also carries the tower's own rate-limit hits (one per tower API request).
        max: (_request, key) => (key === "agent" || key === "operator" ? 1200 : 60),
        allowList: (request) => request.url === "/healthz",
        // Thrown to the error handler, which answers it as too_many_requests.
        errorResponseBuilder: (_request, context) => ({ statusCode: context.statusCode, message: `Rate limit exceeded, retry in ${context.after}.` }),
      }),
    );
  });

  app.register(healthRoutes);

  // Each principal gets its own encapsulated scope so the gate can never leak across routes.
  app.register(
    async (scope) => {
      scope.addHook("onRequest", requireApiKey(config.AGENT_API_KEY));
      if (callEvents) recordCallEvents(scope, callEvents);
      for (const plugin of routes.agentRoutes) await scope.register(plugin);
    },
    { prefix: "/v1" },
  );
  app.register(
    async (scope) => {
      scope.addHook("onRequest", requireApiKey(config.OPERATOR_API_KEY));
      for (const plugin of routes.operatorRoutes) await scope.register(plugin);
    },
    { prefix: "/v1" },
  );

  return app;
}

if (import.meta.main) {
  const config = loadConfig();
  const fmcsa = new FmcsaClient({ webKey: config.FMCSA_API_KEY });
  const census = new CensusClient();
  const twin = new TwinClient({ apiKey: config.HAPPYROBOT_API_KEY });
  const delivery = new OtpDeliveryClient({
    runner: new HappyRobotClient({ apiKey: config.HAPPYROBOT_API_KEY }),
    environment: config.HAPPYROBOT_ENVIRONMENT,
    emailWorkflowId: config.OTP_EMAIL_WORKFLOW_ID,
    ...(config.OTP_SMS_WORKFLOW_ID && { smsWorkflowId: config.OTP_SMS_WORKFLOW_ID }),
  });
  const tmsHealth = new TmsHealthRecorder();
  const tms = new TmsClient({
    host: config.TMS_HOST,
    port: config.TMS_PORT,
    token: config.TMS_TOKEN,
    onExchange: (exchange) => tmsHealth.record(exchange),
  });
  const trips = TripEstimator.fromConfig(config);
  const hits = twinHitStore(twin);
  const app = buildServer(config, {
    agentRoutes: [
      carrierRoutes({ config, fmcsa, census, twin }),
      otpRoutes({ config, census, delivery, twin, tms }),
      loadRoutes({ tms, twin, trips }),
      offerRoutes({ tms, twin }),
      tripRoutes({ tms, twin, trips }),
      holdRoutes({ tms, twin, trips, delivery }),
      handoffRoutes({ twin }),
      capacityRoutes({ twin }),
    ],
    operatorRoutes: [confirmHoldRoutes({ tms, twin, delivery }), releaseHoldRoutes({ twin, delivery }), operatorWallRoutes({ twin, tmsHealth }), operatorInboxRoutes({ twin }), operatorNetworkRoutes({ twin, tms }), operatorCapacityRoutes({ twin, tms, delivery }), rateLimitRoutes({ hits })],
  }, { twin }, hits);
  if (!config.EIA_API_KEY || !config.ORS_API_KEY) app.log.warn("trip estimates disabled: EIA_API_KEY/ORS_API_KEY not set");
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}
