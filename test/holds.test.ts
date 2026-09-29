import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { resolveBooking } from "../src/domain/holds.ts";
import { TmsClient } from "../src/infra/tms/tms-client.ts";
import { TwinError, type SqlStatement } from "../src/infra/twin-client.ts";
import { confirmHoldRoutes, holdRoutes, releaseHoldRoutes } from "../src/routes/holds.ts";
import { buildServer } from "../src/server.ts";
import { startFakeTms, type FakeBehavior, type FakeTms } from "./fake-tms-server.ts";
import { testConfig } from "./test-config.ts";

describe("resolveBooking", () => {
  it("books with the reference on success", () => {
    expect(resolveBooking({ outcome: "booked", bookingRef: "BR1" })).toEqual({ status: "booked", bookingRef: "BR1", reason: null });
  });

  it("treats ALREADY_BOOKED after a possibly committed attempt as our unconfirmed booking", () => {
    expect(resolveBooking({ outcome: "rejected", code: "ALREADY_BOOKED", ambiguous: true })).toEqual({
      status: "booked_unconfirmed",
      bookingRef: null,
      reason: "already_booked_after_retry",
    });
  });

  it("releases on a clean ALREADY_BOOKED and on other business errors", () => {
    expect(resolveBooking({ outcome: "rejected", code: "ALREADY_BOOKED", ambiguous: false })).toEqual({
      status: "released",
      bookingRef: null,
      reason: "load_taken",
    });
    for (const code of ["INVALID_RATE", "UNKNOWN_LOAD"]) {
      expect(resolveBooking({ outcome: "rejected", code, ambiguous: false })).toEqual({ status: "released", bookingRef: null, reason: code });
    }
  });

  it("never returns an ambiguous outage to 'held', but returns a clean one", () => {
    expect(resolveBooking({ outcome: "unavailable", ambiguous: true })).toMatchObject({ status: "booked_unconfirmed" });
    expect(resolveBooking({ outcome: "unavailable", ambiguous: false })).toEqual({ status: "held", bookingRef: null, reason: null });
  });
});

type Call = { verified: boolean; mcNumber: string | null };
type Offer = { callId: string; loadId: string; round: number; decision: string; rateToSay: number | null };
type Hold = {
  hold_id: string;
  call_id: string;
  load_id: string;
  mc_number: string | null;
  agreed_rate: string;
  status: string;
  booking_ref: string | null;
  idempotency_key: string | null;
  release_reason: string | null;
  created_at: string;
  updated_at: string;
  posted_rate?: string;
  max_buy?: string;
};

const unique = (name: string) => new TwinError(`duplicate key value violates unique constraint "${name}"`);
const text = (pattern: RegExp, sql: string) => pattern.exec(sql)?.[1] ?? "";
const nullable = (literal: string | undefined) => (literal === undefined || literal === "NULL" ? null : literal.slice(2, -1));
const stamp = "2026-09-29T12:00:00.000Z";
const seeded = (fields: Partial<Hold> & Pick<Hold, "hold_id">): Hold => ({
  call_id: "call-a",
  load_id: "LD00881",
  mc_number: "123456",
  agreed_rate: "2300",
  status: "held",
  booking_ref: null,
  idempotency_key: null,
  release_reason: null,
  created_at: stamp,
  updated_at: stamp,
  ...fields,
});

// In-memory stand-in for the statements the hold routes run, enforcing the same unique constraints.
function fakeTwin() {
  const settings: { autonomy: "human" | "autonomous" | null } = { autonomy: null };
  const calls = new Map<string, Call>();
  const offers: Offer[] = [];
  const holds: Hold[] = [];
  const query = async <T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> => {
    // Lets concurrent requests interleave between statements, as they would over HTTP.
    await yieldTurn();
    const sql = statement.text;
    const rows: object[] = [];
    if (sql.startsWith("SELECT c.verified, c.mc_number")) {
      const callId = text(/c\.call_id = E'([^']*)'\s*$/, sql);
      const loadId = text(/o\.load_id = E'([^']*)'/, sql);
      const rate = Number(text(/o\.rate_to_say = (\d+)/, sql));
      const call = calls.get(callId);
      if (call) {
        const onLoad = offers.filter((o) => o.callId === callId && o.loadId === loadId);
        const latest = onLoad.reduce<(typeof onLoad)[number] | undefined>((a, o) => (a && a.round > o.round ? a : o), undefined);
        const agreed =
          onLoad.some((o) => o.decision === "accept" && o.rateToSay === rate) ||
          (latest?.decision === "counter" && latest.rateToSay === rate);
        rows.push({ verified: call.verified, mc_number: call.mcNumber, agreed, autonomy: settings.autonomy });
      }
    } else if (sql.startsWith("SELECT * FROM holds WHERE load_id")) {
      const loadId = text(/load_id = E'([^']*)'/, sql);
      rows.push(...holds.filter((h) => h.load_id === loadId && h.status !== "released"));
    } else if (sql.startsWith("INSERT INTO holds")) {
      const [, callId = "", loadId = "", mc, rate = "", postedRate, maxBuy] =
        /VALUES \(E'([^']*)', E'([^']*)', (NULL|E'[^']*'), (\d+), (\d+), (\d+)\)/.exec(sql) ?? [];
      if (holds.some((h) => h.load_id === loadId && h.status !== "released")) throw unique("holds_one_active_per_load");
      const hold = seeded({
        hold_id: randomUUID(),
        call_id: callId,
        load_id: loadId,
        mc_number: nullable(mc),
        agreed_rate: rate,
        ...(postedRate !== undefined && { posted_rate: postedRate }),
        ...(maxBuy !== undefined && { max_buy: maxBuy }),
      });
      holds.push(hold);
      rows.push(hold);
    } else if (sql.startsWith("SELECT * FROM holds WHERE hold_id")) {
      const holdId = text(/hold_id = E'([^']*)'/, sql);
      const key = /idempotency_key = E'([^']*)'/.exec(sql)?.[1];
      rows.push(...holds.filter((h) => h.hold_id === holdId || (key !== undefined && h.idempotency_key === key)));
    } else if (sql.startsWith("UPDATE holds SET status = 'confirming'")) {
      const holdId = text(/hold_id = E'([^']*)'/, sql);
      const key = text(/idempotency_key = E'([^']*)'/, sql);
      const hold = holds.find((h) => h.hold_id === holdId && h.status === "held");
      if (hold) {
        if (holds.some((h) => h !== hold && h.idempotency_key === key)) throw unique("holds_idempotency_key_key");
        Object.assign(hold, { status: "confirming", idempotency_key: key });
        rows.push(hold);
      }
    } else if (sql.startsWith("UPDATE holds SET status = 'released'")) {
      const holdId = text(/hold_id = E'([^']*)'/, sql);
      const reason = text(/release_reason = E'([^']*)'/, sql);
      const hold = holds.find((h) => h.hold_id === holdId && h.status === "held");
      if (hold) {
        Object.assign(hold, { status: "released", release_reason: reason });
        rows.push(hold);
      }
    } else if (sql.startsWith("UPDATE holds SET status =")) {
      const [, status = "", ref, reason, key] =
        /status = E'(\w+)', booking_ref = (NULL|E'[^']*'),\s+release_reason = (NULL|E'[^']*'), idempotency_key = (NULL|E'[^']*')/.exec(sql) ?? [];
      const holdId = text(/hold_id = E'([^']*)'/, sql);
      const hold = holds.find((h) => h.hold_id === holdId && h.status === "confirming");
      if (hold) {
        Object.assign(hold, { status, booking_ref: nullable(ref), release_reason: nullable(reason), idempotency_key: nullable(key) });
        rows.push(hold);
      }
    } else {
      throw new TwinError(`unexpected SQL: ${sql}`);
    }
    return rows.map((row) => rowSchema.parse({ ...row }));
  };
  return { twin: { query }, calls, offers, holds, settings };
}

const agentKey = testConfig.AGENT_API_KEY;
const operatorKey = testConfig.OPERATOR_API_KEY;

describe("hold routes", () => {
  let state: ReturnType<typeof fakeTwin>;
  let fake: FakeTms;
  let app: ReturnType<typeof buildServer>;

  async function start(script: FakeBehavior[] = []) {
    fake = await startFakeTms({ token: testConfig.TMS_TOKEN, script });
    const tms = new TmsClient({
      host: "127.0.0.1",
      port: fake.port,
      token: testConfig.TMS_TOKEN,
      attemptDeadlineMs: 200,
      backoffBaseMs: 1,
    });
    app = buildServer(testConfig, {
      agentRoutes: [holdRoutes({ tms, twin: state.twin })],
      operatorRoutes: [confirmHoldRoutes({ tms, twin: state.twin }), releaseHoldRoutes({ twin: state.twin })],
    });
  }

  beforeEach(() => {
    state = fakeTwin();
    state.calls.set("call-a", { verified: true, mcNumber: "123456" });
    state.calls.set("call-b", { verified: true, mcNumber: "654321" });
    state.calls.set("call-unverified", { verified: false, mcNumber: "111111" });
    state.calls.set("call-no-mc", { verified: true, mcNumber: null });
  });
  afterEach(async () => {
    await app.close();
    await fake.close();
  });

  const offer = (callId: string, loadId: string, decision: string, rateToSay: number) =>
    state.offers.push({ callId, loadId, round: state.offers.filter((o) => o.callId === callId && o.loadId === loadId).length + 1, decision, rateToSay });
  const accept = (callId: string, loadId: string, rateToSay: number) => offer(callId, loadId, "accept", rateToSay);

  const createHold = (payload: object, key = agentKey) =>
    app.inject({ method: "POST", url: "/v1/holds", headers: { "x-api-key": key }, payload });

  const confirm = (holdId: string, idempotencyKey?: string, key = operatorKey) =>
    app.inject({
      method: "POST",
      url: `/v1/holds/${holdId}/confirm`,
      headers: { "x-api-key": key, ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }) },
    });

  const release = (holdId: string, payload?: object, key = operatorKey) =>
    app.inject({
      method: "POST",
      url: `/v1/holds/${holdId}/release`,
      headers: { "x-api-key": key },
      ...(payload === undefined ? {} : { payload }),
    });

  const bookRequests = () => fake.requests.filter((line) => line.includes("CMD:LOAD_BOOK"));

  // LD00881 on the fake board: posted 2093, max buy 2538, OPEN.
  async function heldLoad(callId = "call-a", rate = 2300): Promise<string> {
    accept(callId, "LD00881", rate);
    const res = await createHold({ callId, loadId: "LD00881", agreedRate: rate });
    const body = res.json();
    expect(body).toMatchObject({ status: "ok", holdStatus: "held" });
    return body.holdId;
  }

  describe("POST /v1/holds", () => {
    beforeEach(() => start());

    it("holds an agreed load without promising the booking", async () => {
      accept("call-a", "LD00881", 2300);
      const res = await createHold({ callId: "call-a", loadId: "ld00881", agreedRate: 2300 });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ status: "ok", holdStatus: "held", holdId: expect.any(String) });
      expect(body.message).toContain("$2,300");
      expect(body.message).toMatch(/senior rep/);
      expect(body.message).not.toMatch(/\bbooked\b/i);
      expect(state.holds).toMatchObject([{ call_id: "call-a", load_id: "LD00881", mc_number: "123456", agreed_rate: "2300", status: "held" }]);
      // The posted rate and max buy are stored with the hold for the operator; the agent never sees them.
      expect(state.holds[0]).toMatchObject({ posted_rate: "2093", max_buy: "2538" });
      expect(res.body).not.toMatch(/max_?buy|2538/i);
      expect(bookRequests()).toEqual([]);
    });

    it("requires a verified call", async () => {
      accept("call-unverified", "LD00881", 2300);
      for (const callId of ["call-unverified", "call-unknown"]) {
        const res = await createHold({ callId, loadId: "LD00881", agreedRate: 2300 });
        expect(res.json()).toEqual({ status: "not_verified", message: expect.any(String), holdId: null, holdStatus: null });
      }
      expect(state.holds).toEqual([]);
    });

    it("requires an accepted offer at exactly that rate", async () => {
      offer("call-a", "LD00881", "counter", 2400);
      accept("call-a", "LD00881", 2300);
      for (const agreedRate of [2301, 2400, 2299]) {
        const res = await createHold({ callId: "call-a", loadId: "LD00881", agreedRate });
        expect(res.json()).toMatchObject({ status: "no_agreement", holdId: null });
      }
      const otherLoad = await createHold({ callId: "call-a", loadId: "LD00848", agreedRate: 2300 });
      expect(otherLoad.json()).toMatchObject({ status: "no_agreement" });
      expect(state.holds).toEqual([]);
    });

    it("holds our latest counter when the carrier takes it, but not an earlier one", async () => {
      offer("call-a", "LD00881", "counter", 2225);
      offer("call-a", "LD00881", "counter", 2350);
      expect((await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2225 })).json()).toMatchObject({ status: "no_agreement" });
      expect((await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2350 })).json()).toMatchObject({ status: "ok", holdStatus: "held" });
    });

    it("refuses a rate above the max buy even with a recorded accept", async () => {
      accept("call-a", "LD00881", 2539);
      const res = await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2539 });
      expect(res.json()).toMatchObject({ status: "no_agreement", holdId: null });
      expect(res.body).not.toContain("2538");
      expect(state.holds).toEqual([]);
    });

    it("asks for an MC number when the call has none", async () => {
      accept("call-no-mc", "LD00881", 2300);
      const res = await createHold({ callId: "call-no-mc", loadId: "LD00881", agreedRate: 2300 });
      expect(res.json()).toMatchObject({ status: "mc_number_required" });
    });

    it("answers load_unavailable for a load the TMS does not have", async () => {
      accept("call-a", "LD99999", 2300);
      const res = await createHold({ callId: "call-a", loadId: "LD99999", agreedRate: 2300 });
      expect(res.json()).toMatchObject({ status: "load_unavailable" });
    });

    it("keeps one active hold per load: same call gets it back, another call is refused", async () => {
      const holdId = await heldLoad("call-a");
      const again = (await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json();
      expect(again).toMatchObject({ status: "ok", holdId });

      accept("call-b", "LD00881", 2250);
      const other = (await createHold({ callId: "call-b", loadId: "LD00881", agreedRate: 2250 })).json();
      expect(other).toMatchObject({ status: "load_on_hold", holdId: null });
      expect(state.holds).toHaveLength(1);
    });

    it("lets the unique index settle two calls racing for one load", async () => {
      accept("call-a", "LD00881", 2300);
      accept("call-b", "LD00881", 2250);
      const results = await Promise.all([
        createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 }),
        createHold({ callId: "call-b", loadId: "LD00881", agreedRate: 2250 }),
      ]);
      expect(results.map((r) => r.json().status).toSorted()).toEqual(["load_on_hold", "ok"]);
      expect(state.holds).toHaveLength(1);
    });

    it("answers invalid_request with HTTP 200 for a malformed body", async () => {
      for (const payload of [{ callId: "call-a", loadId: "LD00881" }, { callId: "call-a", loadId: "LD00881", agreedRate: 2300.5 }]) {
        const res = await createHold(payload);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "invalid_request", holdId: null });
      }
    });

    it("stays behind the agent key", async () => {
      accept("call-a", "LD00881", 2300);
      const res = await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 }, operatorKey);
      expect(res.statusCode).toBe(401);
      expect(state.holds).toEqual([]);
    });
  });

  describe("POST /v1/holds in autonomous mode", () => {
    it("books the hold at once through LOAD_BOOK and says so", async () => {
      await start();
      state.settings.autonomy = "autonomous";
      accept("call-a", "LD00881", 2300);
      const body = (await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json();
      expect(body).toMatchObject({ status: "ok", holdStatus: "booked" });
      expect(body.message).toMatch(/booked/);
      expect(body.message).toContain("$2,300");
      expect(bookRequests()).toHaveLength(1);
      expect(state.holds[0]).toMatchObject({ status: "booked", booking_ref: "BR00000000091277" });
      expect(body.message).not.toContain("2538");
    });

    it("answers a second create_hold for the same call with the booked message", async () => {
      await start();
      state.settings.autonomy = "autonomous";
      accept("call-a", "LD00881", 2300);
      const first = (await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json();
      const second = (await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json();
      expect(second).toEqual(first);
      expect(second).toMatchObject({ status: "ok", holdStatus: "booked" });
      expect(second.message).toMatch(/booked/);
      expect(second.message).not.toMatch(/senior rep/);
      expect(bookRequests()).toHaveLength(1);
    });

    it("leaves the hold for a rep when the TMS does not answer", async () => {
      await start(["ok", "rate-limited", "rate-limited", "rate-limited"]);
      state.settings.autonomy = "autonomous";
      accept("call-a", "LD00881", 2300);
      const body = (await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json();
      expect(body).toMatchObject({ status: "ok", holdStatus: "held" });
      expect(body.message).toMatch(/senior rep/);
      expect(body.message).not.toMatch(/\bbooked\b/i);
      expect(state.holds[0]).toMatchObject({ status: "held" });
    });

    it("never books in human mode", async () => {
      await start();
      state.settings.autonomy = "human";
      accept("call-a", "LD00881", 2300);
      expect((await createHold({ callId: "call-a", loadId: "LD00881", agreedRate: 2300 })).json()).toMatchObject({ holdStatus: "held" });
      expect(bookRequests()).toHaveLength(0);
    });
  });

  describe("POST /v1/holds/:holdId/confirm", () => {
    describe("with a healthy TMS", () => {
      beforeEach(() => start());

      it("books once and replays the same body for the same key", async () => {
        const holdId = await heldLoad();
        const first = await confirm(holdId, "key-1");
        expect(first.statusCode).toBe(200);
        expect(first.json()).toEqual({
          status: "booked",
          message: "Booked in the TMS. Reference BR00000000091277.",
          holdId,
          holdStatus: "booked",
          bookingRef: "BR00000000091277",
          reason: null,
        });
        expect(bookRequests()).toHaveLength(1);
        expect(bookRequests()[0]).toContain("LOAD_ID:LD00881|MC_NUM:123456|AGREED_RATE:2300");

        const replay = await confirm(holdId, "key-1");
        expect(replay.body).toBe(first.body);
        expect(bookRequests()).toHaveLength(1);
      });

      it("answers already_processed for a different key and never books again", async () => {
        const holdId = await heldLoad();
        await confirm(holdId, "key-1");
        const second = (await confirm(holdId, "key-2")).json();
        expect(second).toMatchObject({ status: "already_processed", holdStatus: "booked", bookingRef: "BR00000000091277" });
        expect(bookRequests()).toHaveLength(1);
      });

      it("answers 409 when a key is reused on another hold", async () => {
        const first = await heldLoad("call-a");
        await confirm(first, "key-1");
        state.holds.push({ ...structuredClone(state.holds[0]!), hold_id: randomUUID(), load_id: "LD00848", status: "held", idempotency_key: null, booking_ref: null });
        const other = state.holds[1]!.hold_id;
        const res = await confirm(other, "key-1");
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ status: "conflict" });
        expect(state.holds[1]).toMatchObject({ status: "held", idempotency_key: null });
        expect(bookRequests()).toHaveLength(1);
      });

      it("books exactly once when two keys confirm concurrently", async () => {
        const holdId = await heldLoad();
        const results = await Promise.all([confirm(holdId, "key-1"), confirm(holdId, "key-2")]);
        expect(bookRequests()).toHaveLength(1);
        expect(results.map((r) => r.json().status).toSorted()).toEqual(["already_processed", "booked"]);
        expect(state.holds[0]).toMatchObject({ status: "booked" });
      });

      it("requires the Idempotency-Key header and a hold id", async () => {
        const holdId = await heldLoad();
        for (const res of [await confirm(holdId), await confirm(holdId, ""), await confirm(holdId, "k".repeat(129)), await confirm("not-a-uuid", "key-1")]) {
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ status: "invalid_request", holdStatus: null });
        }
        expect(bookRequests()).toEqual([]);
      });

      it("answers not_found for an unknown hold", async () => {
        const res = await confirm(randomUUID(), "key-1");
        expect(res.json()).toMatchObject({ status: "not_found", holdStatus: null });
      });

      it("stays behind the operator key", async () => {
        const holdId = await heldLoad();
        const res = await confirm(holdId, "key-1", agentKey);
        expect(res.statusCode).toBe(401);
        expect(bookRequests()).toEqual([]);
        expect(state.holds[0]).toMatchObject({ status: "held" });
      });
    });

    it("stores booked_unconfirmed when a silent first attempt is followed by ALREADY_BOOKED", async () => {
      await start(["silence", { errorCode: "ALREADY_BOOKED", message: "Load already booked" }]);
      // Seeded directly so the scripted faults hit LOAD_BOOK, not the hold's LOAD_GET.
      const holdId = randomUUID();
      state.holds.push(seeded({ hold_id: holdId }));
      const res = (await confirm(holdId, "key-1")).json();
      expect(res).toMatchObject({ status: "booked_unconfirmed", holdStatus: "booked_unconfirmed", bookingRef: null, reason: "already_booked_after_retry" });
      expect(bookRequests()).toHaveLength(2);
      const again = (await confirm(holdId, "key-2")).json();
      expect(again).toMatchObject({ status: "already_processed", holdStatus: "booked_unconfirmed" });
      expect(bookRequests()).toHaveLength(2);
    });

    it("releases on a clean ALREADY_BOOKED", async () => {
      await start([{ errorCode: "ALREADY_BOOKED" }]);
      const holdId = randomUUID();
      state.holds.push(seeded({ hold_id: holdId }));
      const first = await confirm(holdId, "key-1");
      expect(first.json()).toMatchObject({ status: "released", holdStatus: "released", reason: "load_taken" });
      expect((await confirm(holdId, "key-1")).body).toBe(first.body);
    });

    it("returns to held on a clean outage and a later confirm books", async () => {
      await start(["rate-limited", "rate-limited", "rate-limited"]);
      const holdId = randomUUID();
      state.holds.push(seeded({ hold_id: holdId }));
      const failed = (await confirm(holdId, "key-1")).json();
      expect(failed).toMatchObject({ status: "tms_unavailable", holdStatus: "held", bookingRef: null });
      expect(state.holds[0]).toMatchObject({ status: "held", idempotency_key: null });

      const retried = (await confirm(holdId, "key-1")).json();
      expect(retried).toMatchObject({ status: "booked", bookingRef: "BR00000000091277" });
      expect(bookRequests()).toHaveLength(4);
    });
  });

  describe("POST /v1/holds/:holdId/release", () => {
    beforeEach(() => start());

    it("releases a held hold and frees the load for another call", async () => {
      const holdId = await heldLoad("call-a");
      const res = await release(holdId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: "released",
        message: "Hold released (released_by_operator). The load is free for other calls.",
        holdId,
        holdStatus: "released",
        bookingRef: null,
        reason: "released_by_operator",
      });

      accept("call-b", "LD00881", 2250);
      const other = (await createHold({ callId: "call-b", loadId: "LD00881", agreedRate: 2250 })).json();
      expect(other).toMatchObject({ status: "ok", holdStatus: "held" });
      expect(bookRequests()).toEqual([]);
    });

    it("stores the operator's reason", async () => {
      const holdId = await heldLoad();
      const res = (await release(holdId, { reason: "  carrier backed out  " })).json();
      expect(res).toMatchObject({ status: "released", reason: "carrier backed out" });
      expect(state.holds[0]).toMatchObject({ status: "released", release_reason: "carrier backed out" });
    });

    it("never releases a hold that is being booked or already booked", async () => {
      for (const status of ["confirming", "booked", "booked_unconfirmed"]) {
        const holdId = randomUUID();
        state.holds.push(seeded({ hold_id: holdId, load_id: `LD-${status}`, status, booking_ref: status === "booked" ? "BR1" : null }));
        const res = (await release(holdId)).json();
        expect(res).toMatchObject({ status: "not_releasable", holdId, holdStatus: status });
        expect(state.holds.find((h) => h.hold_id === holdId)).toMatchObject({ status });
      }
    });

    it("answers not_found for an unknown hold and invalid_request for a bad reason", async () => {
      expect((await release(randomUUID())).json()).toMatchObject({ status: "not_found", holdStatus: null });
      const holdId = await heldLoad();
      for (const payload of [{ reason: "" }, { reason: "x".repeat(201) }]) {
        const res = await release(holdId, payload);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: "invalid_request" });
      }
      expect(state.holds[0]).toMatchObject({ status: "held" });
    });

    it("stays behind the operator key", async () => {
      const holdId = await heldLoad();
      const res = await release(holdId, undefined, agentKey);
      expect(res.statusCode).toBe(401);
      expect(state.holds[0]).toMatchObject({ status: "held" });
    });
  });
});
