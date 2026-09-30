// Offline tournament of counter policies against a grid of simulated carriers. Deterministic:
// every carrier of the grid is played once per load, and walk-aways enter as probabilities,
// so booking rate and gap share are exact expectations, not samples.
// Usage: npm run negotiation:sim                (tournament table and winner)
//        npm run negotiation:sim -- --replay    (what each policy would have said on real Twin offers)
import { z } from "zod";
import { counterRoundingUsd } from "../src/constants.ts";
import { finalRound } from "../src/domain/negotiation.ts";
import { TwinClient, sql } from "../src/infra/twin-client.ts";

type Decision = { decision: "accept" | "counter"; rateToSay: number } | { decision: "reject"; rateToSay: null };
// laneSupply: 0 (few trucks on the lane) to 1 (many trucks chasing the lane's loads).
type OfferContext = { posted: number; maxBuy: number; ask: number; round: number; lastOffer: number; laneSupply: number };
type Policy = (context: OfferContext) => Decision;

const floor25 = (usd: number) => Math.floor(usd / counterRoundingUsd) * counterRoundingUsd;

// Same shape as scheduledCounter: floored to $25, clamped to [posted, maxBuy], posted when there is no gap.
function scheduled(steps: readonly number[], posted: number, maxBuy: number, round: number): number {
  const gap = maxBuy - posted;
  if (gap <= 0) return posted;
  const step = steps[Math.min(Math.max(round, 1), finalRound) - 1] ?? 0;
  return Math.min(Math.max(floor25(posted + step * gap), posted), maxBuy);
}

function schedulePolicy(steps: readonly number[], midpoint: boolean): Policy {
  return ({ posted, maxBuy, ask, round, lastOffer }) => {
    const planned = scheduled(steps, posted, maxBuy, round);
    let counter = planned;
    // Meet the carrier halfway when that costs less than the schedule, but never step back.
    if (midpoint && round < finalRound) {
      counter = Math.max(lastOffer, Math.min(planned, floor25((lastOffer + ask) / 2)));
      if (counter === lastOffer) counter = planned;
    }
    counter = Math.max(counter, lastOffer);
    if (ask <= counter) return { decision: "accept", rateToSay: ask };
    if (round > finalRound) return { decision: "reject", rateToSay: null };
    return { decision: "counter", rateToSay: counter };
  };
}

// Concedes less before the final round on a lane with many trucks; the final step is kept.
function lanePolicy(steps: readonly number[], midpoint: boolean): Policy {
  return (context) => {
    const scale = 1 - 0.5 * context.laneSupply;
    const scaled = steps.map((step, i) => (i < steps.length - 1 ? step * scale : step));
    return schedulePolicy(scaled, midpoint)(context);
  };
}

// The production schedule, copied so a change to it cannot silently move the reference.
const baselineSteps = [0.35, 0.6, 0.8] as const;
export const baselinePolicy = schedulePolicy(baselineSteps, false);

const scheduleCandidates = { even: [0.27, 0.53, 0.8], growing: [0.15, 0.4, 0.8] } as const;
type Candidate = { name: string; steps: readonly number[]; midpoint: boolean };
const candidates: Candidate[] = [
  { name: "baseline+midpoint", steps: baselineSteps, midpoint: true },
  ...Object.entries(scheduleCandidates).flatMap(([name, steps]) => [
    { name, steps, midpoint: false },
    { name: `${name}+midpoint`, steps, midpoint: true },
  ]),
];

// A candidate may lose no booking against the baseline, beyond float noise, in any gate cell.
const bookingTolerance = 1e-9;

// Board p10/p50/p90 of the gap (maxBuy - posted) as a share of the posted rate, over 909 loads.
const postedRate = 2000;
const gapShares = [0.071, 0.148, 0.231];
const loads = gapShares.map((share) => ({ posted: postedRate, maxBuy: postedRate + Math.round(share * postedRate) }));

const tactics = [
  { family: "Boulware", beta: 0.3 },
  { family: "Linear", beta: 1 },
  { family: "Conceder", beta: 3 },
] as const;
type Family = (typeof tactics)[number]["family"];
const reservations = [-0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 1.1];
const openings = [0.1, 0.3, 0.6];
const impatience = [0, 0.1, 0.25];
const laneSupplies = [0, 0.5, 1];
const laneSensitivities = [0, 0.1, 0.2];
// The carrier concedes over this many asks and never reaches its reservation within them.
const carrierDeadline = 4;

type Carrier = { family: Family; beta: number; rho: number; open: number; w: number; s: number; k: number };
const carriers: Carrier[] = tactics.flatMap(({ family, beta }) =>
  reservations.flatMap((rho) =>
    openings.flatMap((open) =>
      impatience.flatMap((w) =>
        laneSupplies.flatMap((s) => laneSensitivities.map((k) => ({ family, beta, rho, open, w, s, k }))),
      ),
    ),
  ),
);

type Outcome = { booked: number; share: number; rounds: number };

// One carrier against one policy on one load. booked is the probability of a booking, share the
// probability-weighted gap share paid, rounds the expected number of asks evaluated.
function play(policy: Policy, carrier: Carrier, load: { posted: number; maxBuy: number }): Outcome {
  const gap = load.maxBuy - load.posted;
  // More trucks on the lane lower what a sensitive carrier will settle for.
  const reservation = load.posted + (carrier.rho - carrier.k * carrier.s) * gap;
  const asks = Array.from({ length: carrierDeadline }, (_, t) =>
    Math.round(reservation + carrier.open * gap * (1 - (t / carrierDeadline) ** (1 / carrier.beta))),
  );
  const outcome: Outcome = { booked: 0, share: 0, rounds: 0 };
  const book = (survival: number, rate: number, round: number) => {
    outcome.booked += survival;
    outcome.share += (survival * (rate - load.posted)) / gap;
    outcome.rounds += survival * round;
  };
  let survival = 1;
  let lastOffer = load.posted;
  let round = 0;
  for (const [t, ask] of asks.entries()) {
    round = t + 1;
    const evaluation = policy({ posted: load.posted, maxBuy: load.maxBuy, ask, round, lastOffer, laneSupply: carrier.s });
    if (evaluation.decision === "accept") {
      book(survival, ask, round);
      return outcome;
    }
    if (evaluation.decision === "reject") break;
    const counter = evaluation.rateToSay;
    const nextAsk = asks[t + 1];
    if (counter >= (nextAsk ?? reservation)) {
      book(survival, counter, round);
      return outcome;
    }
    if (nextAsk === undefined) break;
    outcome.rounds += survival * carrier.w * round;
    survival *= 1 - carrier.w;
    lastOffer = counter;
  }
  // Rejected, or the carrier walked at its last ask: the conversation ended on this round.
  outcome.rounds += survival * round;
  return outcome;
}

export type Metrics = { bookingRate: number; gapShare: number; rounds: number };
type Tally = { n: number; booked: number; share: number; rounds: number };

const emptyTally = (): Tally => ({ n: 0, booked: 0, share: 0, rounds: 0 });
const metrics = (tally: Tally): Metrics => ({
  bookingRate: tally.booked / tally.n,
  gapShare: tally.booked > 0 ? tally.share / tally.booked : 0,
  rounds: tally.rounds / tally.n,
});

export const cellKey = (family: Family, w: number) => `${family} w=${w}`;
export const gateCells = tactics.flatMap(({ family }) => impatience.map((w) => cellKey(family, w)));

export type PolicyResult = {
  name: string;
  overall: Metrics;
  // Gate cells: (tactic family, impatience).
  cells: Record<string, Metrics>;
  byFamily: Record<string, Metrics>;
  byImpatience: Record<string, Metrics>;
  // The same metrics on the carriers of one lane sensitivity only.
  byK: Record<string, { overall: Metrics; cells: Record<string, Metrics> }>;
  passesGate: boolean;
};

function evaluate(name: string, policy: Policy): PolicyResult {
  const tallies = new Map<string, Tally>();
  const add = (key: string, o: Outcome) => {
    const tally = tallies.get(key) ?? emptyTally();
    tally.n += 1;
    tally.booked += o.booked;
    tally.share += o.share;
    tally.rounds += o.rounds;
    tallies.set(key, tally);
  };
  for (const carrier of carriers) {
    for (const load of loads) {
      const o = play(policy, carrier, load);
      const cell = cellKey(carrier.family, carrier.w);
      for (const key of ["all", `cell:${cell}`, `family:${carrier.family}`, `w:${carrier.w}`, `k:${carrier.k}`, `k:${carrier.k}:${cell}`]) {
        add(key, o);
      }
    }
  }
  const get = (key: string) => metrics(tallies.get(key) ?? emptyTally());
  return {
    name,
    overall: get("all"),
    cells: Object.fromEntries(gateCells.map((cell) => [cell, get(`cell:${cell}`)])),
    byFamily: Object.fromEntries(tactics.map(({ family }) => [family, get(`family:${family}`)])),
    byImpatience: Object.fromEntries(impatience.map((w) => [String(w), get(`w:${w}`)])),
    byK: Object.fromEntries(
      laneSensitivities.map((k) => [
        String(k),
        { overall: get(`k:${k}`), cells: Object.fromEntries(gateCells.map((cell) => [cell, get(`k:${k}:${cell}`)])) },
      ]),
    ),
    passesGate: false,
  };
}

const keepsBookings = (cells: Record<string, Metrics>, baseline: Record<string, Metrics>) =>
  gateCells.every((cell) => cells[cell]!.bookingRate >= baseline[cell]!.bookingRate - bookingTolerance);

export type Tournament = { baseline: PolicyResult; results: PolicyResult[]; winner: PolicyResult | undefined };

// Winner: the lowest gap share among candidates that keep the baseline's booking rate in every
// gate cell. The lane candidate must also keep it on carriers that ignore lane supply (k = 0).
export function runTournament(): Tournament {
  const baseline = evaluate("baseline", baselinePolicy);
  baseline.passesGate = true;
  const byGapShare = (a: PolicyResult, b: PolicyResult) => a.overall.gapShare - b.overall.gapShare;
  const scheduleResults = candidates.map((c) => {
    const result = evaluate(c.name, schedulePolicy(c.steps, c.midpoint));
    result.passesGate = keepsBookings(result.cells, baseline.cells);
    return result;
  });
  const bestSchedule = scheduleResults.filter((r) => r.passesGate).sort(byGapShare)[0];
  const laneBase = candidates.find((c) => c.name === bestSchedule?.name);
  const laneResults = laneBase
    ? [evaluate(`lane(${laneBase.name})`, lanePolicy(laneBase.steps, laneBase.midpoint))].map((result) => {
        result.passesGate =
          keepsBookings(result.cells, baseline.cells) && keepsBookings(result.byK["0"]!.cells, baseline.byK["0"]!.cells);
        return result;
      })
    : [];
  const results = [baseline, ...scheduleResults, ...laneResults];
  const winner = [...scheduleResults, ...laneResults]
    .filter((r) => r.passesGate && r.overall.gapShare < baseline.overall.gapShare)
    .sort(byGapShare)[0];
  return { baseline, results, winner };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const table = (header: string[], rows: string[][]) =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function printTournament({ baseline, results, winner }: Tournament) {
  console.log(
    table(
      ["policy", "booking rate", "gap share", "rounds", "passes gate"],
      results.map((r) => [r.name, pct(r.overall.bookingRate), pct(r.overall.gapShare), r.overall.rounds.toFixed(3), r.passesGate ? "yes" : "no"]),
    ),
  );
  console.log("\nBooking rate per (tactic family, impatience) cell\n");
  console.log(table(["policy", ...gateCells], results.map((r) => [r.name, ...gateCells.map((cell) => pct(r.cells[cell]!.bookingRate))])));
  console.log("\nPer tactic family (booking rate / gap share)\n");
  console.log(
    table(
      ["policy", ...tactics.map((t) => t.family)],
      results.map((r) => [r.name, ...tactics.map(({ family }) => `${pct(r.byFamily[family]!.bookingRate)} / ${pct(r.byFamily[family]!.gapShare)}`)]),
    ),
  );
  console.log("\nPer impatience (booking rate / gap share)\n");
  console.log(
    table(
      ["policy", ...impatience.map((w) => `w=${w}`)],
      results.map((r) => [r.name, ...impatience.map((w) => `${pct(r.byImpatience[w]!.bookingRate)} / ${pct(r.byImpatience[w]!.gapShare)}`)]),
    ),
  );
  const lane = results.find((r) => r.name.startsWith("lane("));
  if (lane) {
    console.log("\nLane candidate per lane sensitivity k (booking rate / gap share, baseline in brackets)\n");
    console.log(
      table(
        ["k", lane.name, "baseline", "keeps bookings"],
        laneSensitivities.map((k) => {
          const l = lane.byK[k]!;
          const b = baseline.byK[k]!;
          return [
            String(k),
            `${pct(l.overall.bookingRate)} / ${pct(l.overall.gapShare)}`,
            `[${pct(b.overall.bookingRate)} / ${pct(b.overall.gapShare)}]`,
            keepsBookings(l.cells, b.cells) ? "yes" : "no",
          ];
        }),
      ),
    );
  }
  console.log(`\nwinner: ${winner?.name ?? "none"}`);
}

// Replays the asks carriers really made, round by round, through every schedule policy. The
// lane candidate is left out: the offers table has no lane supply, and at zero supply it is its base.
async function replay() {
  const env = z.object({ HAPPYROBOT_API_KEY: z.string().min(1) }).parse(process.env);
  const twin = new TwinClient({ apiKey: env.HAPPYROBOT_API_KEY });
  const rows = await twin.query(
    sql`SELECT call_id, load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy
        FROM offers
        WHERE call_id NOT LIKE 'demo-%' AND posted_rate IS NOT NULL AND max_buy IS NOT NULL
        ORDER BY call_id, load_id, round`,
    z.object({
      call_id: z.string(),
      load_id: z.string(),
      round: z.coerce.number(),
      carrier_ask: z.coerce.number(),
      decision: z.string(),
      rate_to_say: z.coerce.number().nullable(),
      posted_rate: z.coerce.number(),
      max_buy: z.coerce.number(),
    }),
  );
  const groups = Map.groupBy(rows, (r) => `${r.call_id} ${r.load_id}`);
  const policies: [string, Policy][] = [["baseline", baselinePolicy], ...candidates.map((c): [string, Policy] => [c.name, schedulePolicy(c.steps, c.midpoint)])];
  console.log(`${groups.size} negotiations from ${rows.length} offers\n`);
  for (const [key, offers] of groups) {
    const first = offers[0]!;
    console.log(`${key}  posted ${first.posted_rate}  max buy ${first.max_buy}  asks ${offers.map((o) => o.carrier_ask).join(", ")}`);
    console.log(`  actual: ${offers.map((o) => `${o.decision} ${o.rate_to_say ?? ""}`.trim()).join(", ")}`);
    for (const [name, policy] of policies) {
      const said: string[] = [];
      let agreed: number | undefined;
      let lastOffer = first.posted_rate;
      for (const [i, offer] of offers.entries()) {
        const evaluation = policy({ posted: first.posted_rate, maxBuy: first.max_buy, ask: offer.carrier_ask, round: i + 1, lastOffer, laneSupply: 0 });
        said.push(`${evaluation.decision} ${evaluation.rateToSay ?? ""}`.trim());
        if (evaluation.decision !== "counter") {
          if (evaluation.decision === "accept") agreed = evaluation.rateToSay;
          break;
        }
        lastOffer = evaluation.rateToSay;
      }
      console.log(`  ${name.padEnd(18)} ${said.join(", ")}  agreed: ${agreed ?? "none"}`);
    }
  }
}

if (import.meta.main) {
  if (process.argv.includes("--replay")) await replay();
  else printTournament(runTournament());
}
