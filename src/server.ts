import Fastify, { type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { loadConfig, type Config } from "./config.ts";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { CensusClient } from "./infra/census-client.ts";
import { FmcsaClient } from "./infra/fmcsa-client.ts";
import { OtpDeliveryClient } from "./infra/otp-delivery-client.ts";
import { TmsClient } from "./infra/tms/tms-client.ts";
import { TwinClient } from "./infra/twin-client.ts";
import { requireApiKey } from "./plugins/auth.ts";
import { recordCallEvents, type CallEventDeps } from "./plugins/call-events.ts";
import { carrierRoutes } from "./routes/carriers.ts";
import { handoffRoutes } from "./routes/handoff.ts";
import { healthRoutes } from "./routes/health.ts";
import { confirmHoldRoutes, holdRoutes, releaseHoldRoutes } from "./routes/holds.ts";
import { loadRoutes } from "./routes/loads.ts";
import { offerRoutes } from "./routes/offers.ts";
import { otpRoutes } from "./routes/otp.ts";

export type RouteSets = {
  agentRoutes: FastifyPluginAsync[];
  operatorRoutes: FastifyPluginAsync[];
};

// Call events are recorded only when a Twin is given, so route tests can leave them out.
export function buildServer(config: Config, routes: RouteSets, callEvents?: CallEventDeps) {
  const app = Fastify({
    logger: { redact: ["req.headers[\"x-api-key\"]", "req.headers.authorization"] },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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
  const tms = new TmsClient({ host: config.TMS_HOST, port: config.TMS_PORT, token: config.TMS_TOKEN });
  const app = buildServer(config, {
    agentRoutes: [
      carrierRoutes({ fmcsa, census, twin }),
      otpRoutes({ config, census, delivery, twin }),
      loadRoutes({ tms, twin }),
      offerRoutes({ tms, twin }),
      holdRoutes({ tms, twin }),
      handoffRoutes,
    ],
    operatorRoutes: [confirmHoldRoutes({ tms, twin }), releaseHoldRoutes({ twin })],
  }, { twin });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}
