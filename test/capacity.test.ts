import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlStatement, TwinClient } from "../src/infra/twin-client.ts";
import { capacityRoutes } from "../src/routes/capacity.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

type Query = (statement: SqlStatement) => Promise<unknown[]>;
type Call = { verified: boolean; mc_number: string | null };

// Answers the call lookup with `call` and records every other statement.
const twinWith = (call: Call | undefined) =>
  vi.fn<Query>(async (statement) => (statement.text.startsWith("SELECT verified, mc_number FROM calls") && call ? [call] : []));

const serverWith = (query: Query) => {
  const twin = { query: query as TwinClient["query"] };
  return buildServer(testConfig, { agentRoutes: [capacityRoutes({ twin })], operatorRoutes: [] });
};

// Far enough ahead that the desk's "today" never passes it while the suite runs.
const body = {
  callId: "call-1",
  city: "Dallas",
  state: "tx",
  freeDate: "2099-01-15",
  equipmentType: "dry van",
  preferredDestinationState: "",
  consent: "yes",
};

const post = (app: ReturnType<typeof serverWith>, payload: object | string) =>
  app.inject({ method: "POST", url: "/v1/capacity", headers: { "x-api-key": testConfig.AGENT_API_KEY }, payload });

const inserts = (query: ReturnType<typeof twinWith>) =>
  query.mock.calls.map(([statement]) => statement.text).filter((text) => text.startsWith("INSERT INTO truck_capacity"));

let app: ReturnType<typeof serverWith> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("POST /v1/capacity", () => {
  it("saves the truck with an upsert keyed on the call", async () => {
    const query = twinWith({ verified: true, mc_number: "123456" });
    app = serverWith(query);
    const res = await post(app, body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      message: "Got it, your truck is on file. If a load opens up near there we'll send you the details.",
    });
    const [insert] = inserts(query);
    expect(insert).toContain("VALUES (E'call-1', E'123456', E'Dallas', E'TX', E'DRY_VAN', E'2099-01-15', NULL)");
    expect(insert).toContain("ON CONFLICT (call_id) DO UPDATE SET");
    expect(insert).not.toContain("notified_");
  });

  it("stores any equipment as NULL", async () => {
    const query = twinWith({ verified: true, mc_number: "123456" });
    app = serverWith(query);
    await post(app, { ...body, equipmentType: "any", preferredDestinationState: "ga" });
    expect(inserts(query)[0]).toContain("E'TX', NULL, E'2099-01-15', E'GA')");
  });

  it("refuses an unverified call or one without an MC number", async () => {
    for (const call of [undefined, { verified: false, mc_number: "123456" }, { verified: true, mc_number: null }]) {
      const query = twinWith(call);
      app = serverWith(query);
      expect((await post(app, body)).json()).toMatchObject({ status: "not_verified" });
      expect(inserts(query)).toEqual([]);
      await app.close();
      app = undefined;
    }
  });

  it("writes nothing without an explicit yes", async () => {
    for (const consent of ["no", "", "maybe"]) {
      const query = twinWith({ verified: true, mc_number: "123456" });
      app = serverWith(query);
      expect((await post(app, { ...body, consent })).json()).toMatchObject({ status: "no_consent" });
      expect(inserts(query)).toEqual([]);
      await app.close();
      app = undefined;
    }
  });

  it("refuses a free date already past in the desk's zone", async () => {
    const query = twinWith({ verified: true, mc_number: "123456" });
    app = serverWith(query);
    const res = await post(app, { ...body, freeDate: "2020-01-01" });
    expect(res.json()).toEqual({ status: "invalid_request", message: "That date has already passed. When does the truck free up?" });
    expect(inserts(query)).toEqual([]);
  });

  it("answers a blank body with a 200 invalid_request", async () => {
    const query = twinWith(undefined);
    app = serverWith(query);
    const res = await post(app, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "invalid_request" });
    expect(query).not.toHaveBeenCalled();
  });

  it("tells the agent when the Twin is down", async () => {
    app = serverWith(async () => {
      throw new Error("twin down");
    });
    expect((await post(app, body)).json()).toMatchObject({ status: "service_unavailable" });
  });
});
