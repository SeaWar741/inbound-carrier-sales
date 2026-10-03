// Holds block a load for one call until an operator books it in the TMS.

import { counterAnswerMinSeconds } from "../constants.ts";

// "unheard": the rate is our latest counter, but too fresh for the carrier to have heard and taken it.
export type RateAgreement = "agreed" | "unheard" | "none";

// The carrier said an accepted ask themselves, so it holds at once. Our counter holds only once
// it was on the table long enough to be said and answered; counterAgeSeconds is null when the
// latest offer on the load is not a counter at that rate.
export function rateAgreement(accepted: boolean, counterAgeSeconds: number | null): RateAgreement {
  if (accepted) return "agreed";
  if (counterAgeSeconds === null) return "none";
  return counterAgeSeconds >= counterAnswerMinSeconds ? "agreed" : "unheard";
}

export type BookingAttempt =
  | { outcome: "booked"; bookingRef: string }
  | { outcome: "rejected"; code: string; ambiguous: boolean }
  | { outcome: "unavailable"; ambiguous: boolean };

export type HoldResolution = {
  status: "booked" | "booked_unconfirmed" | "released" | "held";
  bookingRef: string | null;
  reason: string | null;
};

// Per the TMS spec, a booking is per token and permanent, so ALREADY_BOOKED after an attempt
// that may have committed is almost surely our own booking, just without a reference.
export function resolveBooking(attempt: BookingAttempt): HoldResolution {
  switch (attempt.outcome) {
    case "booked":
      return { status: "booked", bookingRef: attempt.bookingRef, reason: null };
    case "rejected":
      if (attempt.code === "ALREADY_BOOKED") {
        return attempt.ambiguous
          ? { status: "booked_unconfirmed", bookingRef: null, reason: "already_booked_after_retry" }
          : { status: "released", bookingRef: null, reason: "load_taken" };
      }
      return { status: "released", bookingRef: null, reason: attempt.code };
    case "unavailable":
      // A written request may have committed: a human checks the TMS instead of a blind retry.
      return attempt.ambiguous
        ? { status: "booked_unconfirmed", bookingRef: null, reason: "tms_unavailable_after_send" }
        : { status: "held", bookingRef: null, reason: null };
  }
}
