import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { loadConfig, type Config } from "../src/config.ts";
import { checkCode, generateCode, hashCode } from "../src/domain/otp.ts";
import type { SqlStatement } from "../src/infra/twin-client.ts";
import type { CarrierMessage } from "../src/infra/otp-delivery-client.ts";
import type { LoadDetail } from "../src/infra/tms/codec.ts";
import { TmsBusinessError, TmsUnavailableError } from "../src/infra/tms/errors.ts";
import { otpRoutes, type OtpRouteDeps } from "../src/routes/otp.ts";
import { buildServer } from "../src/server.ts";
import { testConfig } from "./test-config.ts";

describe("otp policy", () => {
  it("generates six-digit codes", () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("binds the hash to the call and never stores the code", () => {
    const hash = hashCode("secret", "call-1", "123456");
    expect(hash).not.toContain("123456");
    expect(hashCode("secret", "call-2", "123456")).not.toBe(hash);
    expect(hashCode("other-secret", "call-1", "123456")).not.toBe(hash);
  });

  const now = new Date("2026-09-29T12:00:00Z");
  const challenge = (attempts: number, expiresInMs = 60_000) => ({
    otpHash: hashCode("s", "c", "111111"),
    expiresAt: new Date(now.getTime() + expiresInMs),
    attempts,
  });

  it("verifies the right code and counts down wrong ones", () => {
    expect(checkCode(challenge(1), hashCode("s", "c", "111111"), now)).toEqual({ result: "verified" });
    expect(checkCode(challenge(1), hashCode("s", "c", "222222"), now)).toEqual({ result: "wrong_code", attemptsLeft: 2 });
    expect(checkCode(challenge(3), hashCode("s", "c", "222222"), now)).toEqual({ result: "locked" });
  });

  it("accepts the right code on the last attempt but not after it", () => {
    expect(checkCode(challenge(3), hashCode("s", "c", "111111"), now)).toEqual({ result: "verified" });
    expect(checkCode(challenge(4), hashCode("s", "c", "111111"), now)).toEqual({ result: "locked" });
  });

  it("rejects an expired code even when it matches", () => {
    expect(checkCode(challenge(1, -1), hashCode("s", "c", "111111"), now)).toEqual({ result: "expired" });
  });
});

type CallState = {
  dotNumber: string | null;
  eligible: boolean;
  sendsLastHour: number;
  otpHash: string | null;
  otpExpiresAt: Date;
  otpAttempts: number;
  verified: boolean;
  mcNumber: string | null;
};

// In-memory stand-in for the statements the OTP routes run against Twin.
function fakeTwin(calls: Map<string, CallState>) {
  const statements: string[] = [];
  // Runs just before the verify UPDATE, to interleave a concurrent change.
  const hooks: { beforeVerify?: () => void } = {};
  // Notified load ids by MC, newest first, and loads another call holds.
  const notices = new Map<string, string[]>();
  const heldElsewhere = new Set<string>();
  const idOf = (text: string) => /call_id = E'([^']+)'/.exec(text)?.[1] ?? "";
  const query = async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    const text = statement.text;
    statements.push(text);
    const call = calls.get(idOf(text));
    const rows: unknown[] = [];
    if (text.startsWith("SELECT c.dot_number")) {
      if (call) rows.push({ dot_number: call.dotNumber, eligible: call.eligible, sends_last_hour: String(call.sendsLastHour) });
    } else if (text.includes("SET otp_hash =") && call) {
      call.otpHash = /otp_hash = E'([0-9a-f]+)'/.exec(text)?.[1] ?? null;
      call.otpExpiresAt = new Date(Date.now() + 300_000);
      call.otpAttempts = 0;
      rows.push({ call_id: idOf(text) });
    } else if (text.includes("SET otp_attempts = otp_attempts + 1")) {
      if (call?.otpHash) {
        call.otpAttempts += 1;
        rows.push({
          otp_hash: call.otpHash,
          otp_expires_at: call.otpExpiresAt.toISOString(),
          otp_attempts: String(call.otpAttempts),
          db_now: new Date().toISOString(),
        });
      }
    } else if (text.includes("SET verified = TRUE") && call) {
      hooks.beforeVerify?.();
      const expected = /AND otp_hash = E'([0-9a-f]+)'/.exec(text)?.[1];
      if (expected !== undefined && call.otpHash === expected) {
        call.verified = true;
        call.otpHash = null;
        rows.push({ mc_number: call.mcNumber });
      }
    } else if (text.includes("FROM truck_capacity")) {
      const mc = /mc_number = E'([^']*)'/.exec(text)?.[1] ?? "";
      rows.push(...(notices.get(mc) ?? []).map((id) => ({ notified_load_id: id })));
    } else if (text.includes("FROM holds")) {
      const ids = [...(/IN \(([^)]*)\)/.exec(text)?.[1] ?? "").matchAll(/E'([^']*)'/g)].map((m) => m[1] ?? "");
      rows.push(...ids.filter((id) => heldElsewhere.has(id)).map((id) => ({ load_id: id })));
    }
    return rows.map((row) => rowSchema.parse(row));
  };
  return { twin: { query }, statements, hooks, notices, heldElsewhere };
}

const eligibleCall = (): CallState => ({
  dotNumber: "80806",
  eligible: true,
  sendsLastHour: 0,
  otpHash: null,
  otpExpiresAt: new Date(0),
  otpAttempts: 0,
  verified: false,
  mcNumber: "123456",
});

describe("OTP_FIXED_CODE config gate", () => {
  const env = (overrides: Record<string, string>) =>
    Object.fromEntries(Object.entries({ ...testConfig, PORT: "8080", ...overrides }).map(([k, v]) => [k, String(v)]));

  it("is accepted in demo mode against a local fake TMS", () => {
    expect(loadConfig(env({ OTP_FIXED_CODE: "424242" })).OTP_FIXED_CODE).toBe("424242");
    expect(loadConfig(env({ OTP_FIXED_CODE: "424242", TMS_HOST: "localhost" })).OTP_FIXED_CODE).toBe("424242");
  });

  it("refuses to boot against a real TMS host or in live mode", () => {
    expect(() => loadConfig(env({ OTP_FIXED_CODE: "424242", TMS_HOST: "tms.example.com" }))).toThrow(/OTP_FIXED_CODE/);
    expect(() => loadConfig(env({ OTP_FIXED_CODE: "424242", OTP_DELIVERY_MODE: "live" }))).toThrow(/OTP_FIXED_CODE/);
  });
});

describe("OTP routes", () => {
  const calls = new Map<string, CallState>();
  const { twin, statements, hooks, notices, heldElsewhere } = fakeTwin(calls);
  const getLoad = vi.fn<OtpRouteDeps["tms"]["getLoad"]>();
  const send = vi.fn<(channel: "email" | "sms", to: string, message: CarrierMessage) => Promise<string>>();
  const supports = vi.fn<(channel: "email" | "sms") => boolean>();
  const contactByDot = vi.fn<OtpRouteDeps["census"]["contactByDot"]>();
  const routeConfig = { ...testConfig } satisfies Config;
  const deps: OtpRouteDeps = { config: routeConfig, census: { contactByDot }, delivery: { send, supports }, twin, tms: { getLoad } };
  const app = buildServer(testConfig, { agentRoutes: [otpRoutes(deps)], operatorRoutes: [] });
  afterAll(() => app.close());

  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, payload, headers: { "x-api-key": testConfig.AGENT_API_KEY } });
  const sentCode = () => /\b(\d{6})\b/.exec(send.mock.calls.at(-1)?.[2].body ?? "")?.[1] ?? "";

  beforeEach(() => {
    calls.clear();
    statements.length = 0;
    send.mockReset().mockResolvedValue("run-1");
    supports.mockReset().mockReturnValue(true);
    contactByDot.mockReset().mockResolvedValue({
      email: "dispatch@carrier.example",
      phone: "5555550142",
      cellPhone: null,
      mcs150Date: null,
    });
    routeConfig.OTP_DELIVERY_MODE = "demo";
    delete routeConfig.OTP_FIXED_CODE;
    delete hooks.beforeVerify;
    notices.clear();
    heldElsewhere.clear();
    getLoad.mockReset().mockImplementation(async (loadId) => ({ loadId, status: "OPEN" }) as LoadDetail);
  });

  it("sends to the demo recipient by default and never returns or stores the code", async () => {
    calls.set("call-1", eligibleCall());
    const res = await post("/v1/otp/send", { callId: "call-1", channel: "email" });

    expect(res.json()).toMatchObject({ status: "ok", sent: true, maskedDestination: "d***@e***.com", expiresInSeconds: 300 });
    expect(send).toHaveBeenCalledWith("email", "demo@example.com", {
      subject: "Your verification code",
      body: expect.stringMatching(/code is \d{6}\. It expires in 5 minutes/),
    });
    // The hold notice later goes to this same contact.
    expect(statements.find((s) => s.includes("SET otp_hash ="))).toMatch(/otp_channel = E'email', otp_destination = E'demo@example\.com'/);
    expect(contactByDot).not.toHaveBeenCalled();
    expect(res.body).not.toContain(sentCode());
    expect(statements.join("\n")).not.toContain(`'${sentCode()}'`);
    expect(calls.get("call-1")?.otpHash).toBe(hashCode(testConfig.OTP_HASH_SECRET, "call-1", sentCode()));
  });

  it("sends the pinned code when OTP_FIXED_CODE is set", async () => {
    routeConfig.OTP_FIXED_CODE = "424242";
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    expect(sentCode()).toBe("424242");
    expect(calls.get("call-1")?.otpHash).toBe(hashCode(testConfig.OTP_HASH_SECRET, "call-1", "424242"));
  });

  it("uses the carrier's contact on file only in live mode", async () => {
    routeConfig.OTP_DELIVERY_MODE = "live";
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "sms" });
    expect(send).toHaveBeenCalledWith("sms", "+15555550142", expect.objectContaining({ body: expect.any(String) }));
  });

  it("refuses carriers that were not verified as eligible", async () => {
    calls.set("call-1", { ...eligibleCall(), eligible: false });
    expect((await post("/v1/otp/send", { callId: "call-1", channel: "email" })).json()).toMatchObject({ status: "not_eligible", sent: false });
    expect((await post("/v1/otp/send", { callId: "unknown", channel: "email" })).json()).toMatchObject({ status: "not_eligible" });
    expect(send).not.toHaveBeenCalled();
  });

  it("skips the per-DOT limit only with a fixed code", async () => {
    routeConfig.OTP_FIXED_CODE = "424242";
    calls.set("call-1", { ...eligibleCall(), sendsLastHour: 3 });
    expect((await post("/v1/otp/send", { callId: "call-1", channel: "email" })).json()).toMatchObject({ status: "ok" });
  });

  it("limits sends per DOT per hour", async () => {
    calls.set("call-1", { ...eligibleCall(), sendsLastHour: 3 });
    expect((await post("/v1/otp/send", { callId: "call-1", channel: "email" })).json()).toMatchObject({ status: "too_many_requests" });
    expect(send).not.toHaveBeenCalled();
  });

  it("answers channel_unavailable when SMS is not configured", async () => {
    calls.set("call-1", eligibleCall());
    supports.mockReturnValue(false);
    expect((await post("/v1/otp/send", { callId: "call-1", channel: "sms" })).json()).toMatchObject({ status: "channel_unavailable" });
  });

  it("reports a delivery failure without leaking it", async () => {
    calls.set("call-1", eligibleCall());
    send.mockRejectedValue(new Error("boom"));
    const res = await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    expect(res.json()).toMatchObject({ status: "delivery_unavailable", sent: false });
    expect(res.body).not.toContain("boom");
  });

  it("verifies the right code once and marks the call verified", async () => {
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    const res = await post("/v1/otp/check", { callId: "call-1", code: sentCode() });
    expect(res.json()).toMatchObject({ status: "ok", verified: true });
    expect(calls.get("call-1")?.verified).toBe(true);
    // The code is spent: a replay finds no active challenge.
    expect((await post("/v1/otp/check", { callId: "call-1", code: sentCode() })).json()).toMatchObject({ status: "no_active_code" });
  });

  const verifiedWith = async (callId = "call-1") => {
    calls.set(callId, eligibleCall());
    await post("/v1/otp/send", { callId, channel: "email" });
    return (await post("/v1/otp/check", { callId, code: sentCode() })).json();
  };

  it("returns no notified loads when the carrier has none", async () => {
    expect(await verifiedWith()).toMatchObject({ status: "ok", notifiedLoadIds: [] });
    expect(getLoad).not.toHaveBeenCalled();
  });

  it("returns the loads we notified this MC about that are still open and unheld, newest first", async () => {
    notices.set("123456", ["LD00005", "LD00004", "LD00005", "LD00003", "LD00002"]);
    heldElsewhere.add("LD00004");
    getLoad.mockImplementation(async (loadId) => {
      if (loadId === "LD00002") throw new TmsBusinessError("LOAD_GET", 1, false, "NOT_FOUND", "Load not found");
      return { loadId, status: loadId === "LD00003" ? "BOOKED" : "OPEN" } as LoadDetail;
    });
    expect(await verifiedWith()).toMatchObject({ status: "ok", notifiedLoadIds: ["LD00005"] });
    expect(getLoad.mock.calls.map(([id]) => id)).toEqual(["LD00005", "LD00004", "LD00003", "LD00002"]);
    const lookup = statements.find((text) => text.includes("FROM truck_capacity")) ?? "";
    expect(lookup).toContain("mc_number = E'123456'");
    expect(lookup).toContain("now() - 3 * interval '1 day'");
    expect(lookup).toContain("ORDER BY notified_at DESC LIMIT 3");
  });

  it("still verifies, with no notified loads, when the board is unavailable", async () => {
    notices.set("123456", ["LD00005"]);
    getLoad.mockRejectedValue(new TmsUnavailableError("LOAD_GET", 3, false, "timeout"));
    expect(await verifiedWith()).toMatchObject({ status: "ok", verified: true, notifiedLoadIds: [] });
  });

  it("skips the lookup for a carrier verified without an MC", async () => {
    calls.set("call-1", { ...eligibleCall(), mcNumber: null });
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    expect((await post("/v1/otp/check", { callId: "call-1", code: sentCode() })).json()).toMatchObject({ status: "ok", notifiedLoadIds: [] });
    expect(statements.some((text) => text.includes("FROM truck_capacity"))).toBe(false);
  });

  it("returns no notified loads on a wrong code", async () => {
    notices.set("123456", ["LD00005"]);
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    const wrong = sentCode() === "000000" ? "000001" : "000000";
    expect((await post("/v1/otp/check", { callId: "call-1", code: wrong })).json()).toMatchObject({ status: "wrong_code", notifiedLoadIds: [] });
    expect(getLoad).not.toHaveBeenCalled();
  });

  it("locks after three wrong codes, even if the fourth is right", async () => {
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    const wrong = sentCode() === "000000" ? "000001" : "000000";
    expect((await post("/v1/otp/check", { callId: "call-1", code: wrong })).json()).toMatchObject({ status: "wrong_code", attemptsLeft: 2 });
    expect((await post("/v1/otp/check", { callId: "call-1", code: wrong })).json()).toMatchObject({ status: "wrong_code", attemptsLeft: 1 });
    expect((await post("/v1/otp/check", { callId: "call-1", code: wrong })).json()).toMatchObject({ status: "locked", attemptsLeft: 0 });
    expect((await post("/v1/otp/check", { callId: "call-1", code: sentCode() })).json()).toMatchObject({ status: "locked", verified: false });
    expect(calls.get("call-1")?.verified).toBe(false);
  });

  it("spends only the challenge it compared: a code replaced meanwhile verifies nothing", async () => {
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "email" });
    const code = sentCode();
    hooks.beforeVerify = () => {
      const call = calls.get("call-1");
      if (call) call.otpHash = hashCode(testConfig.OTP_HASH_SECRET, "call-1", code === "000000" ? "000001" : "000000");
    };
    const res = await post("/v1/otp/check", { callId: "call-1", code });
    expect(res.json()).toMatchObject({ status: "no_active_code", verified: false });
    expect(calls.get("call-1")?.verified).toBe(false);
    const verify = statements.find((text) => text.includes("SET verified = TRUE")) ?? "";
    expect(verify).toContain(`AND otp_hash = E'${hashCode(testConfig.OTP_HASH_SECRET, "call-1", code)}'`);
  });

  it("reads a spoken code with spaces or dashes and a loosely named channel", async () => {
    calls.set("call-1", eligibleCall());
    for (const channel of [" Text ", "SMS message", "txt"]) {
      expect((await post("/v1/otp/send", { callId: "call-1", channel })).json()).toMatchObject({ status: "ok" });
      expect(send).toHaveBeenLastCalledWith("sms", "+15555550100", expect.objectContaining({ body: expect.any(String) }));
    }
    for (const channel of ["E-mail", "mail", "EMAIL"]) {
      expect((await post("/v1/otp/send", { callId: "call-1", channel })).json()).toMatchObject({ status: "ok" });
      expect(send).toHaveBeenLastCalledWith("email", "demo@example.com", expect.objectContaining({ body: expect.any(String) }));
    }
    const code = sentCode();
    const spoken = `${code.slice(0, 3)} - ${code.slice(3)}`;
    expect((await post("/v1/otp/check", { callId: "call-1", code: spoken })).json()).toMatchObject({ status: "ok", verified: true });
  });

  it("answers invalid_request for an unknown channel", async () => {
    const res = await post("/v1/otp/send", { callId: "call-1", channel: "fax" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "invalid_request", sent: false });
  });

  it("answers invalid_request with HTTP 200 for a malformed code", async () => {
    const res = await post("/v1/otp/check", { callId: "call-1", code: "12ab" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "invalid_request", verified: false });
  });
});
