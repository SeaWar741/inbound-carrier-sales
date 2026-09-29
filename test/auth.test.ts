import type { FastifyPluginAsync } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import { testConfig } from "./test-config.ts";
import { buildServer } from "../src/server.ts";

const config: Config = { ...testConfig };

const agentRoute: FastifyPluginAsync = async (app) => {
  app.post("/loads/search", async () => ({ status: "ok" }));
};
const operatorRoute: FastifyPluginAsync = async (app) => {
  app.post("/holds/:holdId/confirm", async () => ({ status: "ok" }));
};

const app = buildServer(config, { agentRoutes: [agentRoute], operatorRoutes: [operatorRoute] });
afterAll(() => app.close());

const post = (url: string, key?: string) =>
  app.inject({ method: "POST", url, headers: key ? { "x-api-key": key } : {} });

describe("auth gates", () => {
  it("serves health without a key", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("admits the agent on agent routes and rejects the operator", async () => {
    expect((await post("/v1/loads/search", config.AGENT_API_KEY)).statusCode).toBe(200);
    expect((await post("/v1/loads/search", config.OPERATOR_API_KEY)).statusCode).toBe(401);
  });

  it("admits the operator on confirm and rejects the agent", async () => {
    expect((await post("/v1/holds/h1/confirm", config.OPERATOR_API_KEY)).statusCode).toBe(200);
    expect((await post("/v1/holds/h1/confirm", config.AGENT_API_KEY)).statusCode).toBe(401);
  });

  it("rejects a missing or wrong key", async () => {
    expect((await post("/v1/loads/search")).statusCode).toBe(401);
    expect((await post("/v1/holds/h1/confirm", "nope")).statusCode).toBe(401);
  });
});
