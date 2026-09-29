import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { otpDigits, otpMaxAttempts, otpMaxSendsPerDotPerHour } from "../constants.ts";

export function generateCode(): string {
  return String(randomInt(0, 10 ** otpDigits)).padStart(otpDigits, "0");
}

// Bound to the call, so a code issued on one call never verifies another.
export function hashCode(secret: string, callId: string, code: string): string {
  return createHmac("sha256", secret).update(`${callId}:${code}`).digest("hex");
}

export function canSend(sendsInLastHour: number): boolean {
  return sendsInLastHour < otpMaxSendsPerDotPerHour;
}

export type Challenge = { otpHash: string; expiresAt: Date; attempts: number };

export type CheckOutcome =
  | { result: "verified" }
  | { result: "wrong_code"; attemptsLeft: number }
  | { result: "expired" }
  | { result: "locked" };

// `attempts` already includes this attempt: it is incremented atomically before the comparison.
export function checkCode(challenge: Challenge, presentedHash: string, now: Date): CheckOutcome {
  if (challenge.attempts > otpMaxAttempts) return { result: "locked" };
  if (challenge.expiresAt.getTime() <= now.getTime()) return { result: "expired" };
  const matches = timingSafeEqual(Buffer.from(challenge.otpHash, "hex"), Buffer.from(presentedHash, "hex"));
  if (matches) return { result: "verified" };
  const attemptsLeft = otpMaxAttempts - challenge.attempts;
  return attemptsLeft > 0 ? { result: "wrong_code", attemptsLeft } : { result: "locked" };
}
