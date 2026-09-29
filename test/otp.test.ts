import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { Config } from "../src/config.ts";
import { checkCode, generateCode, hashCode } from "../src/domain/otp.ts";
import type { SqlStatement } from "../src/infra/twin-client.ts";
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
};

// In-memory stand-in for the three statements the OTP routes run against Twin.
function fakeTwin(calls: Map<string, CallState>) {
  const statements: string[] = [];
  const idOf = (text: string) => /call_id = '([^']+)'/.exec(text)?.[1] ?? "";
  const query = async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    const text = statement.text;
    statements.push(text);
    const call = calls.get(idOf(text));
    const rows: unknown[] = [];
    if (text.startsWith("SELECT c.dot_number")) {
      if (call) rows.push({ dot_number: call.dotNumber, eligible: call.eligible, sends_last_hour: String(call.sendsLastHour) });
    } else if (text.includes("SET otp_hash =") && call) {
      call.otpHash = /otp_hash = '([0-9a-f]+)'/.exec(text)?.[1] ?? null;
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
      call.verified = true;
      call.otpHash = null;
      rows.push({ call_id: idOf(text) });
    }
    return rows.map((row) => rowSchema.parse(row));
  };
  return { twin: { query }, statements };
}

const eligibleCall = (): CallState => ({
  dotNumber: "80806",
  eligible: true,
  sendsLastHour: 0,
  otpHash: null,
  otpExpiresAt: new Date(0),
  otpAttempts: 0,
  verified: false,
});

describe("OTP routes", () => {
  const calls = new Map<string, CallState>();
  const { twin, statements } = fakeTwin(calls);
  const send = vi.fn<(channel: "email" | "sms", to: string, code: string) => Promise<string>>();
  const supports = vi.fn<(channel: "email" | "sms") => boolean>();
  const contactByDot = vi.fn<OtpRouteDeps["census"]["contactByDot"]>();
  const routeConfig = { ...testConfig } satisfies Config;
  const deps: OtpRouteDeps = { config: routeConfig, census: { contactByDot }, delivery: { send, supports }, twin };
  const app = buildServer(testConfig, { agentRoutes: [otpRoutes(deps)], operatorRoutes: [] });
  afterAll(() => app.close());

  const post = (url: string, payload: object) =>
    app.inject({ method: "POST", url, payload, headers: { "x-api-key": testConfig.AGENT_API_KEY } });
  const sentCode = () => send.mock.calls.at(-1)?.[2] ?? "";

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
  });

  it("sends to the demo recipient by default and never returns or stores the code", async () => {
    calls.set("call-1", eligibleCall());
    const res = await post("/v1/otp/send", { callId: "call-1", channel: "email" });

    expect(res.json()).toMatchObject({ status: "ok", sent: true, maskedDestination: "d***@e***.com", expiresInSeconds: 300 });
    expect(send).toHaveBeenCalledWith("email", "demo@example.com", expect.stringMatching(/^\d{6}$/));
    expect(contactByDot).not.toHaveBeenCalled();
    expect(res.body).not.toContain(sentCode());
    expect(statements.join("\n")).not.toContain(`'${sentCode()}'`);
    expect(calls.get("call-1")?.otpHash).toBe(hashCode(testConfig.OTP_HASH_SECRET, "call-1", sentCode()));
  });

  it("uses the carrier's contact on file only in live mode", async () => {
    routeConfig.OTP_DELIVERY_MODE = "live";
    calls.set("call-1", eligibleCall());
    await post("/v1/otp/send", { callId: "call-1", channel: "sms" });
    expect(send).toHaveBeenCalledWith("sms", "+15555550142", expect.any(String));
  });

  it("refuses carriers that were not verified as eligible", async () => {
    calls.set("call-1", { ...eligibleCall(), eligible: false });
    expect((await post("/v1/otp/send", { callId: "call-1", channel: "email" })).json()).toMatchObject({ status: "not_eligible", sent: false });
    expect((await post("/v1/otp/send", { callId: "unknown", channel: "email" })).json()).toMatchObject({ status: "not_eligible" });
    expect(send).not.toHaveBeenCalled();
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

  it("answers invalid_request with HTTP 200 for a malformed code", async () => {
    const res = await post("/v1/otp/check", { callId: "call-1", code: "12ab" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "invalid_request", verified: false });
  });
});
