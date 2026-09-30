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
// search = Twin 2 s + hold check 2 s + LOAD_QUERY 5 s + LOAD_GET 5 s (details in parallel)
//   + trip estimate 4.5 s (every candidate load in parallel, EIA and ORS each bounded by tripVendorTimeoutMs) = 18.5 s;
// offers = Twin 2 s + LOAD_GET 5 s + Twin 2 s = 9 s;
// holds = Twin 2 s x 2 + LOAD_GET 5 s + trip estimate 4.5 s + Twin 2 s x 2 = 17.5 s;
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
// A typo guard on one operator authorization; the real ceiling is always the load's max buy.
export const maxAuthorizationUsd = 1_000;
// TMS health: 500 attempts is well over an hour of demo traffic, and sorting it per wall poll is trivial.
export const tmsHealthLatencySamples = 500;

// Trip ETA: there is no delivery time in the TMS, so ETA = pickup + miles at a long-haul average
// that already absorbs stops and hours-of-service breaks. Cycle 4 replaces it with a routed time.
export const avgTransitMph = 50;
// Operator inbox: one screen of carriers at 1280 px; the page size is not a parameter.
export const inboxPageSize = 25;
// The dashboard's booked loads: a week of pickups is far below this; it only bounds a runaway result.
export const dashboardLoadsLimit = 500;
// A carrier's timeline shows its recent calls, not its full history.
export const carrierCallsLimit = 50;

// Trip estimate. Class 8 tractor-trailers average 6.3 mpg (AFDC data/10310, from FHWA VM-1 2024).
export const truckMpg = 6.3;
// Ohio Turnpike Class 5 E-ZPass, 2026 schedule, per tolled mile. PA and Indiana charge more, so this is
// a floor. ATRI's 4.3 cents is averaged over all miles, tolled or not, and would undercount a tolled lane.
export const tollUsdPerMile = 0.226;
// Hours of service, 49 CFR 395.3: 11 h driving per shift, a 30 min break once driving passes 8 h,
// 10 h off duty between shifts. The 14 h window and the 60/70 h cycle are left out on purpose.
export const hosDriveHoursPerShift = 11;
export const hosBreakAfterHours = 8;
export const hosBreakHours = 0.5;
export const hosOffDutyHours = 10;
// A team keeps the truck rolling about 22 h a day, the rest is fuel, inspections and swaps (FreightWaves).
export const teamDriveHoursPerDay = 22;
// Delivery appointment grace runs from 15 minutes to 2 hours in practice. The loose end is taken so a load
// the receiver would still accept is not refused; past it the load is not pitched or held.
export const lateToleranceHours = 2;
// Search estimates this many times the pitched count, so dropping loads nobody can deliver on time
// still leaves a full pitch when the board has them.
export const searchCandidateFactor = 2;
// EIA publishes weekly on Tuesday about 10:00 ET with Monday's prices; a week old price is the current one.
export const dieselCacheMs = 7 * 24 * 60 * 60 * 1000;
// 5 real calls from a laptop: ORS 254-1577 ms (p95 1.58 s, the first on a cold connection),
// EIA 111-1331 ms (p95 1.33 s). About 3x the slower p95.
export const tripVendorTimeoutMs = 4_500;

// Below this, tolls are spoken as "next to nothing" rather than "about $3 in tolls", which reads oddly aloud.
export const tollsSpokenFloorUsd = 20;
