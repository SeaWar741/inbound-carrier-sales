import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TmsBusinessError, TmsUnavailableError } from "../src/infra/tms/errors.ts";
import { TmsClient, type TmsClientOptions, type TmsExchange } from "../src/infra/tms/tms-client.ts";
import { startFakeTms, type FakeBehavior, type FakeTms } from "./fake-tms-server.ts";

const token = "t-secret-token-123";
const fastTiming = { attemptDeadlineMs: 150, maxAttempts: 3, backoffBaseMs: 5, totalBudgetMs: 2_000 };

let fake: FakeTms | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(script: FakeBehavior[], overrides: Partial<TmsClientOptions> = {}) {
  fake = await startFakeTms({ token, script });
  const exchanges: TmsExchange[] = [];
  const client = new TmsClient({
    host: "127.0.0.1",
    port: fake.port,
    token,
    ...fastTiming,
    onExchange: (exchange) => exchanges.push(exchange),
    ...overrides,
  });
  return { client, fake, exchanges };
}

const rejection = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);

describe("TmsClient happy path", () => {
  it("queries loads with normalized filters and explicit MAX_RESULTS", async () => {
    const { client, fake } = await setup([]);
    const loads = await client.queryLoads({ origState: "ga", equipmentType: "dry van" });
    expect(loads.map((l) => l.loadId)).toEqual(["LD00881", "LD00848"]);
    expect(fake.requests).toEqual([`CMD:LOAD_QUERY|AUTH:${token}|ORIG_STATE:GA|EQTYPE:DRY_VAN|MAX_RESULTS:10`]);
  });

  it("gets a load with maxBuy parsed", async () => {
    const { client } = await setup([]);
    expect(await client.getLoad(" ld00881 ")).toMatchObject({ loadId: "LD00881", rate: 2093, maxBuy: 2538, notes: "" });
  });

  it("echoes", async () => {
    const { client } = await setup([]);
    expect(await client.debugEcho("HELLO")).toEqual({ fieldsParsed: 3, message: "HELLO" });
  });

  it("books against the fake server", async () => {
    const { client, fake } = await setup([]);
    const booking = await client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 2200 });
    expect(booking).toEqual({ loadId: "LD00881", bookingRef: "BR00000000091277", status: "BOOKED", timestampUtc: "20260928193122" });
    expect(fake.requests).toEqual([`CMD:LOAD_BOOK|AUTH:${token}|LOAD_ID:LD00881|MC_NUM:872144|AGREED_RATE:2200`]);
  });

  it("validates input before touching the network", async () => {
    const { client, fake } = await setup([]);
    await expect(client.queryLoads({ origState: "Georgia" })).rejects.toThrow(z.ZodError);
    await expect(client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 0 })).rejects.toThrow(z.ZodError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("TmsClient fault handling", () => {
  it.each([
    ["silence", "timeout"],
    ["empty-close", "empty-close"],
    ["partial", "partial"],
    ["malformed", "malformed"],
    ["rate-limited", "rate-limited"],
  ] as const)("retries %s (classified %s) and then succeeds", async (behavior, fault) => {
    const { client, fake, exchanges } = await setup([behavior]);
    const loads = await client.queryLoads({ origState: "GA" });
    expect(loads).toHaveLength(2);
    expect(fake.requests).toHaveLength(2);
    expect(exchanges.map((e) => e.outcome)).toEqual([fault, "ok"]);
  });

  it("classifies a malformed LOAD_GET record", async () => {
    const { client, exchanges } = await setup(["malformed"]);
    await client.getLoad("LD00881");
    expect(exchanges.map((e) => e.outcome)).toEqual(["malformed", "ok"]);
  });

  it("does not wait for EOF when the server holds the socket after END", async () => {
    const { client, fake } = await setup(["delayed-close"], { attemptDeadlineMs: 1_000 });
    const started = performance.now();
    expect(await client.getLoad("LD00881")).toMatchObject({ loadId: "LD00881" });
    expect(performance.now() - started).toBeLessThan(500);
    expect(fake.requests).toHaveLength(1);
  });

  it("gives up after maxAttempts with the last fault", async () => {
    const { client, fake } = await setup(["empty-close", "partial", "malformed", "ok"]);
    const error = await rejection(client.queryLoads({ origState: "GA" }));
    expect(error).toBeInstanceOf(TmsUnavailableError);
    expect(error).toMatchObject({ fault: "malformed", message: expect.stringContaining("after 3 attempt(s)") });
    expect(fake.requests).toHaveLength(3);
  });

  it("gives up after repeated RATE_LIMITED", async () => {
    const { client } = await setup(["rate-limited", "rate-limited", "rate-limited"]);
    const error = await rejection(client.debugEcho());
    expect(error).toMatchObject({ fault: "rate-limited", ambiguous: false, message: expect.stringContaining("after 3 attempt(s)") });
  });

  it("enforces the per-attempt deadline against a silent server", async () => {
    const { client } = await setup(["silence"], { maxAttempts: 1, attemptDeadlineMs: 100 });
    const started = performance.now();
    const error = await rejection(client.getLoad("LD00881"));
    const elapsed = performance.now() - started;
    expect(error).toMatchObject({ fault: "timeout", message: expect.stringContaining("after 1 attempt(s)") });
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(400);
  });

  it("stops retrying when the total budget is spent", async () => {
    const { client, fake } = await setup(["silence", "silence", "silence", "silence", "silence"], {
      maxAttempts: 5,
      attemptDeadlineMs: 200,
      totalBudgetMs: 350,
    });
    const started = performance.now();
    const error = await rejection(client.getLoad("LD00881"));
    const elapsed = performance.now() - started;
    expect(error).toBeInstanceOf(TmsUnavailableError);
    // Second attempt is cut to the remaining budget, so no attempt starts after 350 ms.
    expect(fake.requests.length).toBeLessThanOrEqual(2);
    expect(elapsed).toBeLessThan(600);
  });
});

describe("TmsClient business errors", () => {
  it.each(["NOT_FOUND", "UNKNOWN_LOAD", "ALREADY_BOOKED", "INVALID_RATE", "MISSING_FIELD", "SERVER_ERROR"])(
    "does not retry %s",
    async (code) => {
      const { client, fake } = await setup([{ errorCode: code, message: "nope" }]);
      const error = await rejection(client.getLoad("LD00881"));
      expect(error).toBeInstanceOf(TmsBusinessError);
      expect(error).toMatchObject({ code, message: expect.stringContaining("LOAD_GET rejected") });
      expect(fake.requests).toHaveLength(1);
    },
  );

  it("maps the real NOT_FOUND answer for an unknown load", async () => {
    const { client } = await setup([]);
    await expect(client.getLoad("LD99999")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("TmsClient booking ambiguity", () => {
  it("flags ALREADY_BOOKED after a silent attempt as ambiguous", async () => {
    const { client, fake } = await setup(["silence", { errorCode: "ALREADY_BOOKED", message: "Load not available" }]);
    const error = await rejection(client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 2200 }));
    expect(error).toBeInstanceOf(TmsBusinessError);
    expect(error).toMatchObject({ code: "ALREADY_BOOKED", ambiguous: true });
    expect(fake.requests).toHaveLength(2);
  });

  it("flags an exhausted booking as ambiguous when a request was written", async () => {
    const { client } = await setup(["empty-close", "partial", "silence"]);
    const error = await rejection(client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 2200 }));
    expect(error).toMatchObject({ fault: "timeout", ambiguous: true });
  });

  it("does not flag a definite refusal as ambiguous", async () => {
    const { client } = await setup(["rate-limited", { errorCode: "UNKNOWN_LOAD" }]);
    const error = await rejection(client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 2200 }));
    expect(error).toMatchObject({ code: "UNKNOWN_LOAD", ambiguous: false });
  });

  it("is not ambiguous when the connection never opened", async () => {
    const client = new TmsClient({ host: "127.0.0.1", port: 1, token, ...fastTiming });
    const error = await rejection(client.bookLoad({ loadId: "LD00881", mcNumber: "872144", agreedRate: 2200 }));
    expect(error).toMatchObject({ fault: "socket-error", ambiguous: false });
  });
});

describe("TmsClient AUTH redaction", () => {
  it("keeps a rejected token out of the AUTH_FAILED error", async () => {
    const { fake } = await setup([]);
    const wrongToken = "t-wrong-token-456";
    const client = new TmsClient({ host: "127.0.0.1", port: fake.port, token: wrongToken, ...fastTiming });
    const error = await rejection(client.debugEcho());
    expect(error).toMatchObject({ code: "AUTH_FAILED" });
    expect(fake.requests).toHaveLength(1);
    expect(`${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.stack : ""}`).not.toContain(wrongToken);
  });

  it("keeps the token out of fault errors and exchange logs", async () => {
    const { client, exchanges } = await setup(["empty-close", "partial", "silence"]);
    const error = await rejection(client.queryLoads({ origState: "GA" }));
    expect(error).toBeInstanceOf(TmsUnavailableError);
    expect(`${String(error)} ${JSON.stringify(error)} ${error instanceof Error ? error.stack : ""}`).not.toContain(token);
    const logged = JSON.stringify(exchanges);
    expect(exchanges).toHaveLength(3);
    expect(logged).not.toContain(token);
    expect(logged).toContain("AUTH:[redacted]");
  });

  it("scrubs the token if the server ever echoes it in MSG", async () => {
    const { client } = await setup([{ errorCode: "MALFORMED", message: `bad AUTH ${token}` }]);
    const error = await rejection(client.debugEcho());
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain(token);
  });
});
