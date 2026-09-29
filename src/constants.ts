// Every tuned number lives here with the observation it was sized against.

// Negotiation: share of the gap (maxBuy - postedRate) conceded per counter round.
// Decreasing steps signal a floor is near; the top 20% of the gap is never offered.
export const concessionSchedule = [0.35, 0.6, 0.8] as const;
// Counters round down to $25 so the agent never speaks cents and never exceeds the schedule.
export const counterRoundingUsd = 25;

// Load search: a voice pitch cannot hold more than ~3 options before the caller loses track.
export const loadsPitchedPerSearch = 3;

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
// Budget for one TMS command including its retries, not for a whole tool call. Worst cases per call:
// search = Twin 2 s + hold check 2 s + LOAD_QUERY 5 s + LOAD_GET 5 s (details in parallel) = 14 s;
// offers = Twin 2 s + LOAD_GET 5 s + Twin 2 s = 9 s; holds = Twin 2 s x 2 + LOAD_GET 5 s + Twin 2 s x 2 = 13 s;
// confirm = Twin 2 s x 2 + LOAD_BOOK 5 s + Twin 2 s = 11 s.
export const tmsTotalBudgetMs = 5_000;

// Twin SQL: measured p95 371 ms for an insert plus a read (~185 ms per statement) from a laptop.
// 2 s is ~10x a statement and still leaves the tool call inside the agent's patience.
export const twinRequestTimeoutMs = 2_000;

// Carrier verification: QCMobile answered in ~0.3 s and Census in ~0.5-0.6 s from a laptop.
// 2 s is ~3x the slower vendor; two sequential rounds still fit inside tmsTotalBudgetMs.
export const verificationRequestTimeoutMs = 2_000;
// An MCS-150 contact change this recent is a common precursor of carrier identity fraud.
export const contactChangeWindowDays = 30;

// Operator wall: "today" is the brokerage's business day, not the server's or UTC's.
export const operatorTimeZone = "America/Chicago";
// The wall shows the tail of a call, not its full history.
export const wallEventsPerCall = 20;
// TMS health: 500 attempts is well over an hour of demo traffic, and sorting it per wall poll is trivial.
export const tmsHealthLatencySamples = 500;
