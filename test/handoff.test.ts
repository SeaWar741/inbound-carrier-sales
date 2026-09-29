import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlStatement, TwinClient } from "../src/infra/twin-client.ts";
import { handoffRoutes } from "../src/routes/handoff.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

type Query = (statement: SqlStatement) => Promise<unknown[]>;

const serverWith = (query: Query) =>
  buildServer(testConfig, { agentRoutes: [handoffRoutes], operatorRoutes: [] }, { twin: { query: query as TwinClient["query"] } });

const post = (app: ReturnType<typeof serverWith>, payload: object, key = testConfig.AGENT_API_KEY) =>
  app.inject({ method: "POST", url: "/v1/calls/request-human", headers: { "x-api-key": key }, payload });

let app: ReturnType<typeof serverWith> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /v1/calls/request-human", () => {
  it("answers with the handoff line and records exactly one call event, through the hook", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);

    const res = await post(app, { callId: "call-1", reason: "wants to talk to a senior rep" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "transferring",
      message: "Let me get a senior rep on the line; they will have everything we covered.",
    });

    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    expect(query.mock.calls[0]?.[0].text).toBe(
      "INSERT INTO call_events (call_id, tool, summary, status) VALUES (E'call-1', E'request_human', E'Carrier asked for a human: wants to talk to a senior rep', E'transferring')",
    );
  });

  it("treats a blank reason as none", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);
    const res = await post(app, { callId: "call-1", reason: "" });
    expect(res.json()).toMatchObject({ status: "transferring" });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    expect(query.mock.calls[0]?.[0].text).toContain("E'request_human', E'Carrier asked for a human', E'transferring'");
  });

  it("answers 200 invalid_request without a call id", async () => {
    app = serverWith(async () => []);
    const res = await post(app, { reason: "anything" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "invalid_request" });
  });

  it("requires the agent key", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);
    expect((await post(app, { callId: "call-1" }, testConfig.OPERATOR_API_KEY)).statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).not.toHaveBeenCalled();
  });
});
