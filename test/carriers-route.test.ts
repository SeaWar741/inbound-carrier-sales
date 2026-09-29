import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.ts";
import { testConfig } from "./test-config.ts";
import { CensusClient } from "../src/infra/census-client.ts";
import { FmcsaClient, FmcsaError } from "../src/infra/fmcsa-client.ts";
import { TwinClient } from "../src/infra/twin-client.ts";
import { carrierRoutes } from "../src/routes/carriers.ts";
import { buildServer } from "../src/server.ts";

const config: Config = { ...testConfig };

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/fmcsa/${name}.json`, import.meta.url), "utf8"));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Real QCMobile and Census payloads, keyed by request path.
const routes = new Map<string, unknown>([
  ["/qc/services/carriers/docket-number/135797", fixture("docket-135797")],
  ["/qc/services/carriers/docket-number/999999", fixture("docket-empty")],
  ["/qc/services/carriers/80806", fixture("carrier-80806")],
  ["/qc/services/carriers/80806/authority", fixture("authority-80806")],
  ["/qc/services/carriers/80806/oos", fixture("oos-80806")],
  ["/qc/services/carriers/4539029", fixture("carrier-4539029")],
  ["/qc/services/carriers/4539029/authority", fixture("authority-4539029")],
  ["/qc/services/carriers/4539029/oos", fixture("oos-4539029")],
  ["/qc/services/carriers/9999998", fixture("carrier-not-found")],
  ["/resource/az4n-8mr2.json?dot_number=80806", fixture("census-80806")],
  ["/resource/az4n-8mr2.json?dot_number=4539029", []],
]);

function vendorFetch(overrides: Map<string, unknown> = new Map()) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const key = url.hostname === "data.transportation.gov" ? `${url.pathname}${url.search}` : url.pathname;
    const body = overrides.get(key) ?? routes.get(key);
    return body === undefined ? jsonResponse({ content: "not mocked" }, 500) : jsonResponse(body);
  });
}

const twinFetch = vi.fn<typeof fetch>();
beforeEach(() => {
  twinFetch.mockReset();
  twinFetch.mockImplementation(async () => jsonResponse({ command: "INSERT", rowCount: 1, rows: [], truncated: false }));
});

function serverWith(fetchImpl: typeof fetch) {
  return buildServer(config, {
    agentRoutes: [
      carrierRoutes({
        fmcsa: new FmcsaClient({ webKey: config.FMCSA_API_KEY, fetch: fetchImpl }),
        census: new CensusClient({ fetch: fetchImpl }),
        twin: new TwinClient({ apiKey: "k", fetch: twinFetch }),
      }),
    ],
    operatorRoutes: [],
  });
}

const app = serverWith(vendorFetch());
afterAll(() => app.close());

const verify = (payload: object, target = app, key = config.AGENT_API_KEY) =>
  target.inject({ method: "POST", url: "/v1/carriers/verify", headers: { "x-api-key": key }, payload });

const lastSql = () => {
  const init = twinFetch.mock.calls.at(-1)?.[1];
  return typeof init?.body === "string" ? init.body : "";
};

describe("POST /v1/carriers/verify", () => {
  it("clears an eligible carrier by MC and records the call", async () => {
    const res = await verify({ callId: "call-1", mcNumber: "MC-135797" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: "ok",
      message: "The carrier is verified and eligible to book loads with us.",
      eligible: true,
      reasons: [],
      carrierName: "J B HUNT TRANSPORT INC",
      dotNumber: "80806",
      mcNumber: "135797",
      maskedContact: { email: "d***@e***.com", phone: "***-***-0142" },
      riskFlags: [],
    });
    expect(res.body).not.toContain("dispatch@example-carrier.com");
    expect(res.body).not.toContain("5555550142");
    expect(lastSql()).toContain("VALUES (E'call-1', E'80806', E'135797', TRUE, FALSE)");
    expect(lastSql()).toContain("ON CONFLICT (call_id) DO UPDATE");
  });

  it("resolves the MC from authority on a DOT lookup", async () => {
    const res = await verify({ callId: "call-2", dotNumber: "DOT 080806" });
    expect(res.json()).toMatchObject({ status: "ok", dotNumber: "80806", mcNumber: "135797" });
  });

  it("rejects a carrier not allowed to operate and under an out-of-service order", async () => {
    const res = await verify({ callId: "call-3", dotNumber: "4539029" });
    expect(res.json()).toMatchObject({
      status: "not_eligible",
      eligible: false,
      reasons: ["not_allowed_to_operate", "out_of_service"],
      carrierName: "NO NAME TRUCKING & REPAIR LLC",
      maskedContact: {},
      riskFlags: ["no_contact_on_file"],
    });
  });

  it("sends a docket matching several carriers to review without picking one", async () => {
    const docket = fixture("docket-135797");
    const duplicated = typeof docket === "object" && docket !== null && "content" in docket && Array.isArray(docket.content)
      ? { ...docket, content: [...docket.content, ...docket.content] }
      : docket;
    const multi = serverWith(vendorFetch(new Map([["/qc/services/carriers/docket-number/135797", duplicated]])));
    const res = await verify({ callId: "call-4", mcNumber: "135797" }, multi);
    await multi.close();
    expect(res.json()).toMatchObject({
      status: "needs_review",
      eligible: false,
      reasons: ["multiple_carriers_matched"],
      carrierName: null,
      dotNumber: null,
      mcNumber: "135797",
    });
    expect(lastSql()).toContain("VALUES (E'call-4', NULL, E'135797', FALSE, FALSE)");
  });

  it("sends an unknown MC or DOT to review", async () => {
    expect((await verify({ callId: "call-5", mcNumber: "999999" })).json()).toMatchObject({
      status: "needs_review",
      reasons: ["carrier_not_found"],
      message: "I couldn't find a carrier with that number. Could you read it to me again?",
    });
    expect((await verify({ callId: "call-6", dotNumber: "9999998" })).json()).toMatchObject({
      status: "needs_review",
      reasons: ["carrier_not_found"],
    });
  });

  it("answers verification_unavailable when a vendor times out, without leaking the web key", async () => {
    const timingOut = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    const slow = serverWith(timingOut);
    const res = await verify({ callId: "call-7", dotNumber: "80806" }, slow);
    await slow.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "verification_unavailable", eligible: false });
    expect(res.body).not.toContain(config.FMCSA_API_KEY);
    expect(twinFetch).not.toHaveBeenCalled();
  });

  it("still clears an eligible carrier when the census times out, with the contact left unknown", async () => {
    const vendors = vendorFetch();
    const censusDown = vi.fn<typeof fetch>(async (input, init) => {
      if (new URL(String(input)).hostname === "data.transportation.gov") {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return vendors(input, init);
    });
    const target = serverWith(censusDown);
    const res = await verify({ callId: "call-10", mcNumber: "135797" }, target);
    await target.close();
    expect(res.json()).toMatchObject({
      status: "ok",
      eligible: true,
      dotNumber: "80806",
      mcNumber: "135797",
      maskedContact: {},
      riskFlags: [],
    });
    expect(lastSql()).toContain("VALUES (E'call-10', E'80806', E'135797', TRUE, FALSE)");
  });

  it("answers verification_unavailable when the Twin write fails", async () => {
    twinFetch.mockResolvedValue(jsonResponse({ message: "boom" }, 500));
    const res = await verify({ callId: "call-8", dotNumber: "80806" });
    expect(res.json()).toMatchObject({ status: "verification_unavailable" });
  });

  it("answers invalid_request with HTTP 200 for a malformed or ambiguous body", async () => {
    for (const payload of [
      { callId: "call-9", mcNumber: "MC12AB" },
      { callId: "call-9", mcNumber: "135797", dotNumber: "80806" },
      { callId: "call-9" },
    ]) {
      const res = await verify(payload);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "invalid_request", eligible: false });
    }
  });

  it("stays behind the agent key", async () => {
    expect((await verify({ callId: "c", mcNumber: "135797" }, app, config.OPERATOR_API_KEY)).statusCode).toBe(401);
  });
});

describe("FmcsaClient", () => {
  it("keeps the web key out of error messages", async () => {
    const client = new FmcsaClient({
      webKey: config.FMCSA_API_KEY,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`fetch failed for ?webKey=${config.FMCSA_API_KEY}`)),
    });
    const error = await client.carrierByDot("80806").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FmcsaError);
    expect(String(error)).not.toContain(config.FMCSA_API_KEY);
  });

  it("treats a server error payload as a vendor failure", async () => {
    const client = new FmcsaClient({
      webKey: "k",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ content: "We encountered an error" }, 500)),
    });
    await expect(client.carrierByDot("1")).rejects.toThrow(FmcsaError);
  });
});

describe("verifyCarrierBody", () => {
  it("treats the agent's blank parameters as absent", async () => {
    const { verifyCarrierBody } = await import("../src/contract.ts");
    expect(verifyCarrierBody.parse({ callId: "c", mcNumber: "", dotNumber: "80806" })).toEqual({ callId: "c", dotNumber: "80806" });
    expect(verifyCarrierBody.safeParse({ callId: "c", mcNumber: "", dotNumber: "" }).success).toBe(false);
  });
});
