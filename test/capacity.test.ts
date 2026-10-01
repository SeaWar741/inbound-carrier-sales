import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { CarrierMessage } from "../src/infra/otp-delivery-client.ts";
import type { LoadDetail, LoadQueryFilters, LoadSummary } from "../src/infra/tms/codec.ts";
import type { SqlStatement, TwinClient } from "../src/infra/twin-client.ts";
import { capacityNotice, capacityRoutes, fitsTruck, operatorCapacityRoutes } from "../src/routes/capacity.ts";
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

describe("fitsTruck", () => {
  const truck = { state: "TX", equipment: "DRY_VAN", freeDate: "2099-01-15" };
  const load = (pickupDay: string, extra: Partial<LoadSummary> = {}) => ({
    origState: "TX",
    equipmentType: "DRY_VAN" as const,
    pickupDateTime: `${pickupDay}080000`,
    ...extra,
  });

  it("fits pickups from the free date through two days after", () => {
    expect(fitsTruck(truck, load("20990114"))).toBe(false);
    expect(fitsTruck(truck, load("20990115"))).toBe(true);
    expect(fitsTruck(truck, load("20990117"))).toBe(true);
    expect(fitsTruck(truck, load("20990118"))).toBe(false);
  });

  it("needs the truck's state and, unless any, its equipment", () => {
    expect(fitsTruck(truck, load("20990115", { origState: "OK" }))).toBe(false);
    expect(fitsTruck(truck, load("20990115", { equipmentType: "REEFER" }))).toBe(false);
    expect(fitsTruck({ ...truck, equipment: null }, load("20990115", { equipmentType: "REEFER" }))).toBe(true);
  });
});

const detail: LoadDetail = {
  loadId: "L100",
  origCity: "Dallas",
  origState: "TX",
  origZip: "75201",
  destCity: "Atlanta",
  destState: "GA",
  destZip: "30301",
  pickupDateTime: "20990116080000",
  equipmentType: "DRY_VAN",
  rate: 2150,
  miles: 780,
  status: "OPEN",
  deliveryDateTime: "20990117180000",
  weight: 40000,
  commodity: "Paper",
  pieces: 20,
  dims: "",
  notes: "",
  maxBuy: 2675,
};

describe("capacityNotice", () => {
  it("quotes the posted rate and never the max buy", () => {
    const notice = capacityNotice(detail, new Date("2099-01-10T18:00:00Z"));
    expect(notice.subject).toBe("Load L100 near Dallas, TX");
    expect(notice.body).toBe(
      "HappyRobot Logistics: on Jan 10 you asked us to keep your truck on file. Load L100, Dallas, TX to Atlanta, GA, dry van, " +
        "pickup Jan 16, 8:00 AM, posted $2,150. Call us back and mention load L100.",
    );
    expect(notice.body).not.toContain("2,675");
    expect(notice.body).not.toContain("2675");
  });
});

type TruckState = { notified_at: string | null; notified_load_id: string | null };
const truckId = "0b0c2a5e-8a39-4b8e-9d7e-0f3f2d1c4b5a";

// A Twin holding one saved truck whose claim behaves like the real conditional UPDATE.
function capacityTwin(contact: { otp_channel: string | null; otp_destination: string | null } = { otp_channel: "email", otp_destination: "ops@carrier.test" }) {
  const truck: TruckState = { notified_at: null, notified_load_id: null };
  const statements: string[] = [];
  const query = async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    const text = statement.text;
    statements.push(text);
    const parse = (rows: object[]) => rows.map((row) => rowSchema.parse(row));
    if (text.includes("WHERE tc.id =")) {
      return parse([
        { state: "TX", equipment: "DRY_VAN", free_date: "2099-01-15", created_at: "2099-01-10T18:00:00Z", ...truck, ...contact },
      ]);
    }
    if (text.startsWith("UPDATE truck_capacity SET notified_load_id = E")) {
      if (truck.notified_at !== null) return [];
      truck.notified_at = "2099-01-12T10:00:00Z";
      truck.notified_load_id = "L100";
      return parse([{ id: truckId }]);
    }
    if (text.startsWith("UPDATE truck_capacity SET notified_load_id = NULL")) {
      truck.notified_at = null;
      truck.notified_load_id = null;
      return [];
    }
    if (text.includes("FROM truck_capacity tc LEFT JOIN calls c")) {
      return parse([
        {
          id: truckId,
          mc_number: "123456",
          carrier_name: "Acme Freight",
          city: "Dallas",
          state: "TX",
          equipment: "DRY_VAN",
          free_date: "2099-01-15",
          preferred_destination_state: "GA",
          notice_channel: contact.otp_destination ? contact.otp_channel : null,
          ...truck,
        },
      ]);
    }
    if (text.startsWith("SELECT load_id FROM holds")) return parse([{ load_id: "L300" }]);
    return [];
  };
  return { query: query as TwinClient["query"], statements, truck };
}

const summary = (loadId: string, extra: Partial<LoadSummary> = {}): LoadSummary => {
  const { deliveryDateTime: _d, weight: _w, commodity: _c, pieces: _p, dims: _s, notes: _n, maxBuy: _m, ...base } = detail;
  return { ...base, loadId, ...extra };
};

type FakeTms = { getLoad?: () => Promise<LoadDetail>; queryLoads?: (filters: LoadQueryFilters) => Promise<LoadSummary[]> };

function operatorServer(
  twin: ReturnType<typeof capacityTwin>,
  tms: FakeTms = {},
  send = vi.fn(async (_channel: string, _to: string, _message: CarrierMessage) => "run-1"),
) {
  const deps = {
    twin,
    tms: { getLoad: tms.getLoad ?? (async () => detail), queryLoads: tms.queryLoads ?? (async () => []) },
    delivery: { send },
  };
  return { app: buildServer(testConfig, { agentRoutes: [], operatorRoutes: [operatorCapacityRoutes(deps)] }), send };
}

const notify = (target: ReturnType<typeof serverWith>, payload: object = { loadId: "L100" }, id = truckId) =>
  target.inject({ method: "POST", url: `/v1/operator/capacity/${id}/notify`, headers: { "x-api-key": testConfig.OPERATOR_API_KEY }, payload });

describe("POST /v1/operator/capacity/:id/notify", () => {
  it("claims the truck once and sends once; a second call is already_notified", async () => {
    const twin = capacityTwin();
    const server = operatorServer(twin);
    app = server.app;
    expect((await notify(app)).json()).toEqual({ status: "sent", message: "The carrier was sent the load." });
    expect((await notify(app)).json()).toMatchObject({ status: "already_notified" });
    expect(server.send).toHaveBeenCalledTimes(1);
    const [channel, to, message] = server.send.mock.calls[0] ?? [];
    expect([channel, to]).toEqual(["email", "ops@carrier.test"]);
    expect(message?.body).toContain("posted $2,150");
    expect(message?.body).not.toContain("2,675");
    expect(twin.statements.filter((text) => text.startsWith("UPDATE truck_capacity SET notified_load_id = E"))).toHaveLength(1);
  });

  it("refuses a load that is no longer open", async () => {
    const twin = capacityTwin();
    const server = operatorServer(twin, { getLoad: async () => ({ ...detail, status: "BOOKED" }) });
    app = server.app;
    expect((await notify(app)).json()).toMatchObject({ status: "load_unavailable" });
    expect(server.send).not.toHaveBeenCalled();
    expect(twin.truck.notified_at).toBeNull();
  });

  it("gives the claim back when the send fails", async () => {
    const twin = capacityTwin();
    const send = vi.fn(async (): Promise<string> => {
      throw new Error("workflow down");
    });
    app = operatorServer(twin, {}, send).app;
    expect((await notify(app)).json()).toMatchObject({ status: "failed" });
    expect(twin.statements.some((text) => text.startsWith("UPDATE truck_capacity SET notified_load_id = NULL, notified_at = NULL"))).toBe(true);
    expect(twin.truck.notified_at).toBeNull();
  });

  it("does not send without a verified contact", async () => {
    const server = operatorServer(capacityTwin({ otp_channel: null, otp_destination: null }));
    app = server.app;
    expect((await notify(app)).json()).toMatchObject({ status: "no_contact" });
    expect(server.send).not.toHaveBeenCalled();
  });

  it("answers a bad id or body with a 400", async () => {
    app = operatorServer(capacityTwin()).app;
    expect((await notify(app, { loadId: "L100" }, "not-a-uuid")).statusCode).toBe(400);
    const res = await notify(app, {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "invalid_request" });
  });
});

describe("GET /v1/operator/capacity", () => {
  const getCapacity = (target: ReturnType<typeof serverWith>) =>
    target.inject({ method: "GET", url: "/v1/operator/capacity", headers: { "x-api-key": testConfig.OPERATOR_API_KEY } });

  it("lists open fitting loads, preferred first, without held loads, the contact or the max buy", async () => {
    const twin = capacityTwin();
    const queryLoads = vi.fn(async (filters: LoadQueryFilters) =>
      filters.pickupDate === "20990115"
        ? [
            summary("L200", { destState: "OK", pickupDateTime: "20990115090000" }),
            summary("L100", { pickupDateTime: "20990115100000" }),
            summary("L300", { pickupDateTime: "20990115110000" }),
            summary("L400", { status: "BOOKED", pickupDateTime: "20990115120000" }),
          ]
        : [],
    );
    app = operatorServer(twin, { queryLoads }).app;
    const res = await getCapacity(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("ops@carrier.test");
    expect(res.body).not.toContain("2675");
    expect(twin.statements[0]).not.toContain("otp_destination AS");
    const [truck] = res.json().trucks;
    expect(truck).toMatchObject({ id: truckId, carrierName: "Acme Freight", noticeChannel: "email", notifiedAt: null });
    expect(truck.loads.map((load: { loadId: string }) => load.loadId)).toEqual(["L100", "L200"]);
    expect(truck.loads[0]).toMatchObject({ origin: "Dallas, TX", destination: "Atlanta, GA", loadboardRate: 2150, preferred: true });
    expect(queryLoads.mock.calls.map(([filters]) => filters)).toEqual([
      { origState: "TX", equipmentType: "DRY_VAN", pickupDate: "20990115", maxResults: 50 },
      { origState: "TX", equipmentType: "DRY_VAN", pickupDate: "20990116", maxResults: 50 },
      { origState: "TX", equipmentType: "DRY_VAN", pickupDate: "20990117", maxResults: 50 },
    ]);

    // The second read comes from the cache.
    await getCapacity(app);
    expect(queryLoads).toHaveBeenCalledTimes(3);
  });

  it("shows null loads for a truck whose board read failed", async () => {
    app = operatorServer(capacityTwin(), {
      queryLoads: async () => {
        throw new Error("tms down");
      },
    }).app;
    const res = await getCapacity(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().trucks[0].loads).toBeNull();
  });
});
