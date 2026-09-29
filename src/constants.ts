// Every tuned number lives here with the observation it was sized against.

// Negotiation: share of the gap (maxBuy - postedRate) conceded per counter round.
// Decreasing steps signal a floor is near; the top 20% of the gap is never offered.
export const concessionSchedule = [0.35, 0.6, 0.8] as const;
// Counters round down to $25 so the agent never speaks cents and never exceeds the schedule.
export const counterRoundingUsd = 25;

// OTP: NIST SP 800-63B allows up to 10 minutes; 5 is enough to read an SMS on a call.
export const otpDigits = 6;
export const otpTtlSeconds = 300;
export const otpMaxAttempts = 3;
export const otpMaxSendsPerDotPerHour = 3;

// TMS: healthy calls take 0.22-0.35 s, a silent fault holds the socket 30 s.
export const tmsAttemptDeadlineMs = 2_000;
// ~15% of calls fault independently: 0.15^3 leaves ~0.34% residual failure.
export const tmsMaxAttempts = 3;
export const tmsBackoffBaseMs = 150;
// Keeps a tool call well under a voice agent's patience.
export const tmsTotalBudgetMs = 5_000;
