import Fastify, { type FastifyPluginAsync } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { loadConfig, type Config } from "./config.ts";
import { CensusClient } from "./infra/census-client.ts";
import { FmcsaClient } from "./infra/fmcsa-client.ts";
import { TwinClient } from "./infra/twin-client.ts";
import { requireApiKey } from "./plugins/auth.ts";
import { carrierRoutes } from "./routes/carriers.ts";
import { healthRoutes } from "./routes/health.ts";

export type RouteSets = {
  agentRoutes: FastifyPluginAsync[];
  operatorRoutes: FastifyPluginAsync[];
};

const defaultRoutes: RouteSets = { agentRoutes: [], operatorRoutes: [] };

export function buildServer(config: Config, routes: RouteSets = defaultRoutes) {
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
  const app = buildServer(config, {
    agentRoutes: [carrierRoutes({ fmcsa, census, twin })],
    operatorRoutes: [],
  });
  await app.listen({ host: "0.0.0.0", port: config.PORT });
}
