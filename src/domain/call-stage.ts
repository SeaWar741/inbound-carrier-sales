import { otpMaxAttempts } from "../constants.ts";
import { finalRound } from "./negotiation.ts";

export const callStages = ["verifying", "otp", "searching", "negotiating", "holding", "booked", "released", "ended"] as const;
export type CallStage = (typeof callStages)[number];

export const callRisks = ["red", "amber", "green"] as const;
export type CallRisk = (typeof callRisks)[number];

// The parts of one wall row the derivation reads; offers are the latest per load.
export type CallSnapshot = {
  eligible: boolean;
  verified: boolean;
  otpAttempts: number;
  humanRequested: boolean;
  offers: readonly { round: number; createdAt: Date }[];
  hold: { status: "held" | "confirming" | "booked" | "booked_unconfirmed" | "released"; createdAt: Date } | null;
  events: readonly { tool: string; status: string | null }[];
};

export type CallAssessment = { stage: CallStage; round: number | null; risk: CallRisk; riskReason: string | null };

// A verified carrier may have spent its last attempt on the right code; only an unverified one is locked out.
export const otpLocked = (call: Pick<CallSnapshot, "verified" | "otpAttempts">) =>
  !call.verified && call.otpAttempts >= otpMaxAttempts;

const latestOffer = (offers: CallSnapshot["offers"]) =>
  offers.reduce<CallSnapshot["offers"][number] | undefined>(
    (latest, offer) => (latest === undefined || offer.createdAt > latest.createdAt ? offer : latest),
    undefined,
  );

function stageOf(call: CallSnapshot, latest: CallSnapshot["offers"][number] | undefined): CallStage {
  // Only a not_eligible verdict ends the call from our data; the tower overlays live/ended from the HappyRobot run status.
  if (!call.eligible) {
    const refused = call.events.some((event) => event.tool === "verify_carrier" && event.status === "not_eligible");
    return refused ? "ended" : "verifying";
  }
  if (!call.verified) return "otp";
  const hold = call.hold;
  if (hold?.status === "booked" || hold?.status === "booked_unconfirmed") return "booked";
  if (hold?.status === "held" || hold?.status === "confirming") return "holding";
  // A released hold stays the headline until the carrier negotiates another load.
  if (hold?.status === "released" && (latest === undefined || latest.createdAt <= hold.createdAt)) return "released";
  return latest ? "negotiating" : "searching";
}

export function assessCall(call: CallSnapshot): CallAssessment {
  const latest = latestOffer(call.offers);
  const stage = stageOf(call, latest);
  const round = latest?.round ?? null;
  const base = { stage, round };
  if (!call.eligible) return { ...base, risk: "red", riskReason: "Carrier not eligible" };
  if (otpLocked(call)) return { ...base, risk: "red", riskReason: "OTP locked" };
  if (call.humanRequested) return { ...base, risk: "red", riskReason: "Carrier asked for a human" };
  if (stage === "negotiating" && round !== null && round >= finalRound) {
    return { ...base, risk: "amber", riskReason: "Final negotiation round" };
  }
  return { ...base, risk: "green", riskReason: null };
}
