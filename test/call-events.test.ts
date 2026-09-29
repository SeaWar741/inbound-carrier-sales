import type { FastifyPluginAsync } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarize, toolName } from "../src/plugins/call-events.ts";
import { TwinClient, type SqlStatement } from "../src/infra/twin-client.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

// Stand-in agent routes answering like the real ones, so the hook sees real paths and bodies.
const agentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/offers/evaluate", async () => ({ status: "ok", message: "I can do $2,100 on this load.", decision: "counter", rateToSay: 2100, round: 2, isFinalRound: false }));
  app.post("/holds", async () => ({ status: "ok", message: "That load is on hold for you.", holdId: "h1", holdStatus: "held" }));
  app.post("/notes/add", async () => ({ status: "ok", message: "Noted." }));
};
const operatorRoutes: FastifyPluginAsync = async (app) => {
  app.post("/operator-action", async () => ({ status: "ok" }));
};

type Query = (statement: SqlStatement) => Promise<unknown[]>;
const serverWith = (query: Query) =>
  buildServer(testConfig, { agentRoutes: [agentRoutes], operatorRoutes: [operatorRoutes] }, { twin: { query: query as TwinClient["query"] } });

const post = (app: ReturnType<typeof serverWith>, url: string, payload: object, key = testConfig.AGENT_API_KEY) =>
  app.inject({ method: "POST", url, headers: { "x-api-key": key }, payload });

let app: ReturnType<typeof serverWith> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("call events hook", () => {
  it("writes one row with the tool, the response status, and a spoken-style summary", async () => {
    const statements: string[] = [];
    app = serverWith(async (statement) => {
      statements.push(statement.text);
      return [];
    });

    const res = await post(app, "/v1/offers/evaluate", { callId: "call-1", loadId: "LD00881", carrierAsk: "2150" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", round: 2 });

    await vi.waitFor(() => expect(statements).toHaveLength(1));
    expect(statements[0]).toBe(
      "INSERT INTO call_events (call_id, tool, summary, status) VALUES (E'call-1', E'evaluate_offer', E'Counter round 2: carrier asks $2,150', E'ok')",
    );
  });

  it("writes nothing for a route without a known tool name", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);
    const res = await post(app, "/v1/notes/add", { callId: "call-1" });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).not.toHaveBeenCalled();
  });

  it("answers the agent without waiting for the write", async () => {
    const pending = vi.fn<Query>(() => new Promise(() => {}));
    app = serverWith(pending);
    const res = await post(app, "/v1/holds", { callId: "call-1", loadId: "LD00841", agreedRate: 2100 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", holdId: "h1" });
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
    expect(pending.mock.calls[0]?.[0].text).toContain("E'Holding load LD00841 at $2,100'");
  });

  it("still answers 200 with the same body when the Twin write fails", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(JSON.stringify({ message: "relation \"call_events\" does not exist" }), { status: 400 }),
    );
    const twin = new TwinClient({ apiKey: "k", fetch });
    app = buildServer(testConfig, { agentRoutes: [agentRoutes], operatorRoutes: [] }, { twin });
    const res = await post(app, "/v1/offers/evaluate", { callId: "call-1", loadId: "LD00881", carrierAsk: 2150 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", decision: "counter" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    // A value the SQL tag refuses to render fails inside the write, not in the request.
    const nul = await post(app, "/v1/holds", { callId: "call-1", loadId: "LD\u00000841", agreedRate: 2100 });
    expect(nul.statusCode).toBe(200);
    expect(nul.json()).toMatchObject({ status: "ok" });
  });

  it("records nothing for a rejected key, a body without a call id, or an operator route", async () => {
    const query = vi.fn<Query>(async () => []);
    app = serverWith(query);
    expect((await post(app, "/v1/holds", { callId: "call-1" }, "wrong-key")).statusCode).toBe(401);
    await post(app, "/v1/holds", { loadId: "LD00841" });
    await post(app, "/v1/operator-action", { callId: "call-1" }, testConfig.OPERATOR_API_KEY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(query).not.toHaveBeenCalled();
  });
});

describe("toolName and summarize", () => {
  it("maps the agent routes to short tool names", () => {
    expect(
      ["/v1/carriers/verify", "/v1/otp/send", "/v1/otp/check", "/v1/loads/search", "/v1/offers/evaluate", "/v1/holds"].map(toolName),
    ).toEqual(["verify_carrier", "send_otp", "check_otp", "search_loads", "evaluate_offer", "create_hold"]);
    expect(toolName("/v1/calls/request-human")).toBeNull();
  });

  it("describes each call from the request, without the code or any rate the agent did not hear", () => {
    expect(summarize("verify_carrier", { mcNumber: "135797" }, {})).toBe("Verifying MC 135797");
    expect(summarize("verify_carrier", { dotNumber: "2229270" }, {})).toBe("Verifying DOT 2229270");
    expect(summarize("send_otp", { channel: "email" }, {})).toBe("Sending verification code by email");
    expect(summarize("check_otp", { code: "123456" }, {})).toBe("Checking verification code");
    expect(summarize("search_loads", { originCity: "Dallas", originState: "TX" }, {})).toBe("Searching loads near Dallas, TX");
    expect(summarize("search_loads", { originZip: "75201" }, {})).toBe("Searching loads near 75201");
    expect(summarize("search_loads", { origin: { city: "Savannah", state: "GA" } }, {})).toBe("Searching loads near Savannah, GA");
    expect(summarize("evaluate_offer", { loadId: "LD1", carrierAsk: 2150 }, { decision: null, round: null })).toBe(
      "Offer on LD1: carrier asks $2,150",
    );
    expect(summarize("evaluate_offer", { carrierAsk: "abc" }, { decision: "accept", round: 1 })).toBe("Accept round 1");
    expect(summarize("create_hold", { loadId: "LD00841", agreedRate: 2100 }, { status: "ok" })).toBe("Holding load LD00841 at $2,100");
    expect(summarize("create_hold", { loadId: "LD00841", agreedRate: 2100 }, { status: "no_agreement" })).toBe("Hold refused on load LD00841 at $2,100");
    expect(summarize("request_human", { reason: "wants rates" }, {})).toBeNull();
    expect(summarize("unknown_tool", { callId: "c" }, {})).toBeNull();
  });
});
