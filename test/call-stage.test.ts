import { describe, expect, it } from "vitest";
import { assessCall, type CallSnapshot } from "../src/domain/call-stage.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 15, minute));

const call = (fields: Partial<CallSnapshot> = {}): CallSnapshot => ({
  eligible: true,
  verified: true,
  otpAttempts: 1,
  humanRequested: false,
  offers: [],
  hold: null,
  events: [],
  ...fields,
});

const offer = (round: number, minute: number) => ({ round, createdAt: at(minute) });
const hold = (status: NonNullable<CallSnapshot["hold"]>["status"], minute = 10) => ({ status, createdAt: at(minute) });

describe("assessCall", () => {
  it.each([
    ["verifying", call({ eligible: false, verified: false, events: [{ tool: "verify_carrier", status: "needs_review" }] }), null, "red"],
    ["ended", call({ eligible: false, verified: false, events: [{ tool: "verify_carrier", status: "not_eligible" }] }), null, "red"],
    ["otp", call({ verified: false, otpAttempts: 0 }), null, "green"],
    ["searching", call(), null, "green"],
    ["negotiating", call({ offers: [offer(1, 1), offer(2, 5)] }), 2, "green"],
    ["holding", call({ offers: [offer(2, 5)], hold: hold("held") }), 2, "green"],
    ["holding", call({ offers: [offer(1, 5)], hold: hold("confirming") }), 1, "green"],
    ["booked", call({ offers: [offer(1, 5)], hold: hold("booked") }), 1, "green"],
    ["booked", call({ offers: [offer(1, 5)], hold: hold("booked_unconfirmed") }), 1, "green"],
    ["released", call({ offers: [offer(1, 5)], hold: hold("released") }), 1, "green"],
    ["negotiating", call({ offers: [offer(1, 5), offer(2, 20)], hold: hold("released") }), 2, "green"],
  ] as const)("derives %s", (stage, snapshot, round, risk) => {
    expect(assessCall(snapshot)).toMatchObject({ stage, round, risk });
  });

  it("uses the round of the latest offer across loads", () => {
    expect(assessCall(call({ offers: [offer(3, 1), offer(1, 9)] }))).toMatchObject({ stage: "negotiating", round: 1, risk: "green" });
  });

  it.each([
    ["not eligible", call({ eligible: false, verified: false }), "Carrier not eligible"],
    ["OTP locked", call({ verified: false, otpAttempts: 3 }), "OTP locked"],
    ["a human was requested", call({ humanRequested: true, offers: [offer(3, 1)] }), "Carrier asked for a human"],
  ])("is red when %s", (_label, snapshot, reason) => {
    expect(assessCall(snapshot)).toMatchObject({ risk: "red", riskReason: reason });
  });

  it("is amber on the final negotiation round", () => {
    expect(assessCall(call({ offers: [offer(3, 1)] }))).toEqual({
      stage: "negotiating",
      round: 3,
      risk: "amber",
      riskReason: "Final negotiation round",
    });
  });

  it("is green once the final round ended in a hold", () => {
    expect(assessCall(call({ offers: [offer(3, 1)], hold: hold("held") }))).toMatchObject({ stage: "holding", risk: "green" });
  });

  it("does not treat a carrier verified on its last attempt as locked", () => {
    expect(assessCall(call({ verified: true, otpAttempts: 3 }))).toMatchObject({ stage: "searching", risk: "green", riskReason: null });
  });
});
