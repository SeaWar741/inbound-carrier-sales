import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlStatement, TwinClient } from "../src/infra/twin-client.ts";
import { handoffRoutes } from "../src/routes/handoff.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

type Query = (statement: SqlStatement) => Promise<unknown[]>;

// The call-events hook is on too, so a double write would show up as a second query.
const serverWith = (query: Query) => {
  const twin = { query: query as TwinClient["query"] };
  return buildServer(testConfig, { agentRoutes: [handoffRoutes({ twin })], operatorRoutes: [] }, { twin });
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const post = (app: ReturnType<typeof serverWith>, payload: object, key = testConfig.AGENT_API_KEY) =>
  app.inject({ method: "POST", url: "/v1/calls/request-human", headers: { "x-api-key": key }, payload });

let app: ReturnType<typeof serverWith> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /v1/calls/request-human", () => {
  it("records the request before promising a rep, in exactly one call event", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);

    const res = await post(app, { callId: "call-1", reason: "wants to talk to a senior rep" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "transferring",
      message: "Let me get a senior rep on the line; they will have everything we covered.",
    });

    await settle();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0].text).toBe(
      "INSERT INTO call_events (call_id, tool, summary, status) VALUES (E'call-1', 'request_human', E'Carrier asked for a human: wants to talk to a senior rep', 'transferring')",
    );
  });

  it("treats a blank reason as none", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);
    const res = await post(app, { callId: "call-1", reason: "" });
    expect(res.json()).toMatchObject({ status: "transferring" });
    await settle();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0].text).toContain("'request_human', E'Carrier asked for a human', 'transferring'");
  });

  it("does not promise a rep when the request cannot be recorded", async () => {
    const query = vi.fn<Query>(async () => {
      throw new Error("twin down");
    });
    app = serverWith(query);
    const res = await post(app, { callId: "call-1", reason: "rates" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "invalid_request",
      message: "I couldn't reach a senior rep just now. Let me keep helping you in the meantime.",
    });
    expect(res.json().message).not.toMatch(/on the line/);
    await settle();
    expect(query).toHaveBeenCalledOnce();
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
    await settle();
    expect(query).not.toHaveBeenCalled();
  });
});
