// Fills Twin with the demo dataset (scripts/demo-dataset.ts): about two months of carrier calls with their
// offers, holds, searches, trucks on file, rep interventions and the conversation itself. Every row hangs
// off a `demo-` call id and the seed runs its own teardown first, so a rerun never duplicates.
// Grounded in real sources, all read only: lanes, freight and rates from the TMS board, a share of the
// carriers from FMCSA with their real verdict, and trip costs from the same estimator create_hold uses.
// Hold notices from the tower go to DEMO_NOTICE_EMAIL; unset, demo calls carry no contact, so a real
// carrier is never emailed.
// Usage: npm run seed:demo               (teardown, then seed)
//        npm run seed:demo -- --teardown
//        npm run seed:demo -- --dry-run   (read the sources and generate, print a sample, write nothing)
import { z } from "zod";
import { tmsWallClockToDate as tmsDate } from "../src/domain/trip.ts";
import { verifyCarrier } from "../src/domain/verification.ts";
import { FmcsaClient, type FmcsaCarrier } from "../src/infra/fmcsa-client.ts";
import type { LoadDetail } from "../src/infra/tms/codec.ts";
import { TmsClient } from "../src/infra/tms/tms-client.ts";
import { TripEstimator, zip3Centroids } from "../src/infra/trip-estimator.ts";
import { TwinClient, sql, type SqlStatement } from "../src/infra/twin-client.ts";
import { openBoard } from "../src/routes/operator-network.ts";
import { buildDataset, type DemoCarrier, type Equipment, type LaneTemplate, type LiveLoad, type Place, type Row } from "./demo-dataset.ts";

const env = z
  .object({
    HAPPYROBOT_API_KEY: z.string().min(1),
    TMS_HOST: z.string().min(1),
    TMS_PORT: z.coerce.number().int().positive(),
    TMS_TOKEN: z.string().min(1),
    FMCSA_API_KEY: z.string().min(1),
    // Without either key every demo hold is stored without a trip, like create_hold does.
    EIA_API_KEY: z.string().min(1).optional(),
    ORS_API_KEY: z.string().min(1).optional(),
    DEMO_NOTICE_EMAIL: z.string().email().optional(),
  })
  .parse(process.env);
const twin = new TwinClient({ apiKey: env.HAPPYROBOT_API_KEY });
const run = (statement: SqlStatement) => twin.query(statement, z.unknown());

const demoTables = ["call_transcripts", "interventions", "call_events", "offers", "holds", "load_searches", "truck_capacity", "calls"];
// Always filtered on the demo mark: never an unfiltered delete.
async function teardown() {
  for (const table of demoTables) await run({ text: `DELETE FROM ${table} WHERE call_id LIKE 'demo-%'` });
}
if (process.argv.includes("--teardown")) {
  await teardown();
  console.log("demo rows removed");
  process.exit(0);
}

// --- the board: lanes, freight and rates ----------------------------------------------------------

const tms = new TmsClient({ host: env.TMS_HOST, port: env.TMS_PORT, token: env.TMS_TOKEN });
const board = (await openBoard(tms, console)).filter((load) => !["HI", "AK"].includes(load.origState) && !["HI", "AK"].includes(load.destState));
const details: LoadDetail[] = [];
for (const load of board) {
  // One read at a time keeps the seed far under the TMS limit of 4 per second.
  details.push(await tms.getLoad(load.loadId));
}
console.log(`board: ${details.length} open loads read`);

const places = new Map<string, Place>();
for (const d of details) {
  places.set(`${d.origCity}|${d.origState}`, { city: d.origCity, state: d.origState, zip: d.origZip });
  places.set(`${d.destCity}|${d.destState}`, { city: d.destCity, state: d.destState, zip: d.destZip });
}
const placeList = [...places.values()].filter((p) => zip3Centroids.has(p.zip.slice(0, 3)));

// Road miles from the zip3 centroids: great circle times the usual 1.2 road factor.
function roadMiles(a: Place, b: Place): number {
  const [lng1, lat1] = zip3Centroids.get(a.zip.slice(0, 3))!;
  const [lng2, lat2] = zip3Centroids.get(b.zip.slice(0, 3))!;
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return Math.round(2 * 3958.8 * Math.asin(Math.sqrt(h)) * 1.2);
}

const equipmentMix: [Equipment, number][] = [["DRY_VAN", 40], ["REEFER", 25], ["FLATBED", 18], ["STEP_DECK", 7], ["POWER_ONLY", 10]];
let seed = 20261001;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
const weighted = <T>(entries: readonly [T, number][]) => {
  let roll = random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of entries) if ((roll -= w) < 0) return v;
  return entries[0]![0];
};

// The board's $/mile and max-buy share per equipment, so invented loads price like real ones.
const pricing = new Map<Equipment, { perMile: number[]; maxRatio: number[] }>();
for (const d of details) {
  const entry = pricing.get(d.equipmentType as Equipment) ?? { perMile: [], maxRatio: [] };
  entry.perMile.push(d.rate / d.miles);
  entry.maxRatio.push(d.maxBuy / d.rate);
  pricing.set(d.equipmentType as Equipment, entry);
}
const freight = details.map((d) => ({ commodity: d.commodity, weight: d.weight, pieces: d.pieces, notes: d.notes, equipment: d.equipmentType }));

function laneBetween(origin: Place, destination: Place, equipment: Equipment): LaneTemplate | null {
  const miles = roadMiles(origin, destination);
  if (miles < 150 || miles > 2600) return null;
  const prices = pricing.get(equipment) ?? pricing.get("DRY_VAN")!;
  // Short hauls pay more per mile, as on the board.
  const perMile = pick(prices.perMile) * (miles < 400 ? 1.25 : miles > 1500 ? 0.92 : 1);
  const cargo = pick(freight.filter((f) => f.equipment === equipment).length > 0 ? freight.filter((f) => f.equipment === equipment) : freight);
  return { origin, destination, miles, equipment, ratePerMile: perMile, maxBuyRatio: pick(prices.maxRatio), commodity: cargo.commodity, weight: cargo.weight, pieces: cargo.pieces, notes: cargo.notes };
}

const lanes: LaneTemplate[] = details.map((d) => ({
  origin: { city: d.origCity, state: d.origState, zip: d.origZip },
  destination: { city: d.destCity, state: d.destState, zip: d.destZip },
  miles: d.miles,
  equipment: d.equipmentType as Equipment,
  ratePerMile: d.rate / d.miles,
  maxBuyRatio: d.maxBuy / d.rate,
  commodity: d.commodity,
  weight: d.weight,
  pieces: d.pieces,
  notes: d.notes,
}));
while (lanes.length < 160) {
  const lane = laneBetween(pick(placeList), pick(placeList), weighted(equipmentMix));
  if (lane) lanes.push(lane);
}

// Lanes carriers ask for that the board has nothing for, by origin state and equipment, for the demand radar.
const covered = new Set(details.map((d) => `${d.origState}|${d.equipmentType}`));
const unmetLanes = lanes.filter((l) => !covered.has(`${l.origin.state}|${l.equipment}`)).slice(0, 6);

const today = new Date();
// A load another call holds cannot take a demo hold too (one active hold per load).
const held = new Set(
  (
    await twin.query(
      sql`SELECT load_id FROM holds WHERE load_id IN (${details.map((d) => d.loadId)}) AND status <> 'released'`,
      z.object({ load_id: z.string() }),
    )
  ).map((row) => row.load_id),
);
const liveLoads: LiveLoad[] = details
  .filter((d) => !held.has(d.loadId) && tmsDate(d.pickupDateTime) > new Date(today.getTime() + 6 * 3_600_000))
  .slice(0, 8)
  .map((d) => ({
    ...lanes.find((l) => l.origin.zip === d.origZip && l.destination.zip === d.destZip && l.miles === d.miles)!,
    loadId: d.loadId,
    rate: d.rate,
    maxBuy: d.maxBuy,
    pickupAt: tmsDate(d.pickupDateTime).toISOString(),
    deliveryAt: tmsDate(d.deliveryDateTime).toISOString(),
  }));


// --- carriers: some real ones from FMCSA, the rest invented -------------------------------------

const fmcsa = new FmcsaClient({ webKey: env.FMCSA_API_KEY });
const nameSearch = z.object({ content: z.array(z.object({ carrier: z.object({ dotNumber: z.number(), phyState: z.string().nullish(), totalPowerUnits: z.number().nullish() }) })).nullish() });
const realCarriers: DemoCarrier[] = [];
const contacts = ["Mike", "Carlos", "Dave", "Jessica", "Raj", "Andre", "Luis", "Brian", "Maria", "Sergei", "Kevin", "Tasha", "Omar", "Jake", "Priya", "Tony", "Darnell", "Gabe", "Nikolai", "Rosa", "Steve", "Ahmed", "Lena", "Marcus"];
const cadences: [DemoCarrier["cadence"], number][] = [["top", 8], ["regular", 30], ["occasional", 40], ["lapsed", 10], ["new", 12]];
const homeFor = (state: string | null | undefined) => placeList.find((p) => p.state === state) ?? pick(placeList);

for (const keyword of ["express", "transport", "trucking", "freight", "logistics", "carriers", "hauling", "transportation", "lines", "brothers"]) {
  if (realCarriers.length >= 26) break;
  const response = await fetch(`https://mobile.fmcsa.dot.gov/qc/services/carriers/name/${keyword}?webKey=${env.FMCSA_API_KEY}&size=40`);
  const found = nameSearch.parse(await response.json()).content ?? [];
  const candidates = found.map((f) => f.carrier).filter((c) => (c.totalPowerUnits ?? 0) >= 2 && (c.totalPowerUnits ?? 0) <= 80);
  for (const candidate of candidates.slice(0, 15)) {
    if (realCarriers.length >= 26) break;
    const dot = String(candidate.dotNumber);
    const carrier: FmcsaCarrier | null = await fmcsa.carrierByDot(dot);
    if (!carrier) continue;
    const [authorities, outOfService] = await Promise.all([fmcsa.authorities(dot), fmcsa.outOfServiceOrders(dot)]);
    const mc = authorities.find((a) => a.prefix === "MC" && a.docketNumber != null)?.docketNumber;
    if (mc == null) continue;
    const verdict = verifyCarrier({ match: "one", carrier, authorities, outOfService, contact: null, now: today });
    // Keep a few the desk would turn away, most of them eligible.
    if (verdict.status !== "ok" && realCarriers.filter((c) => c.status !== "ok").length >= 5) continue;
    realCarriers.push({
      mc: String(mc),
      dot,
      name: carrier.legalName ?? carrier.dbaName ?? `DOT ${dot}`,
      real: true,
      status: verdict.status,
      equipment: weighted(equipmentMix),
      home: homeFor(candidate.phyState),
      contact: pick(contacts),
      cadence: weighted(cadences),
    });
  }
}
console.log(`fmcsa: ${realCarriers.length} real carriers, ${realCarriers.filter((c) => c.status !== "ok").length} not cleared`);

const firstWords = ["Ridgeline", "Blue Ox", "Prairie Wind", "Iron Horse", "Lone Star", "Cascade", "Great Lakes", "Sunbelt", "Keystone", "Red River", "Summit", "Patriot", "Silver Creek", "Gulf Coast", "Heartland", "Copperline", "Northbound", "Liberty", "Eagle Ridge", "Pine Valley", "Big Sky", "Bayou", "Granite", "Trinity", "Apex", "Frontier", "Coastal", "Twin Peaks", "Rio Grande", "Badger State", "Hoosier", "Buckeye", "Magnolia", "Palmetto", "Ozark", "Sierra", "Timberline", "Desert Sun", "Blackwater", "Crossroads", "Harbor", "Longhorn", "Mesa", "Cumberland", "Tidewater", "Brazos", "Wolf Creek", "High Plains"];
const suffixes = ["Transport LLC", "Trucking Inc", "Logistics LLC", "Freight Lines Inc", "Carriers LLC", "Express Inc", "Hauling LLC", "Transportation Co"];
const invented: DemoCarrier[] = [];
const usedNames = new Set<string>();
while (invented.length < 96) {
  const name = `${pick(firstWords)} ${pick(suffixes)}`;
  if (usedNames.has(name)) continue;
  usedNames.add(name);
  invented.push({
    // Above every MC and DOT issued so far, so no invented carrier shares a real one's number.
    mc: String(2_100_000 + Math.floor(random() * 800_000)),
    dot: String(5_100_000 + Math.floor(random() * 800_000)),
    name,
    real: false,
    status: random() < 0.03 ? "needs_review" : "ok",
    equipment: weighted(equipmentMix),
    home: pick(placeList),
    contact: pick(contacts),
    cadence: weighted(cadences),
  });
}

// --- generate and write -------------------------------------------------------------------------

const trips = TripEstimator.fromConfig(env);
const tripLog = { warn: (_details: object, message: string) => console.warn(message) };
// ORS free directions allow 40 a minute: one estimate at a time, a new lane 1.6 s after the last; the estimator caches each lane.
let tripQueue = Promise.resolve<unknown>(undefined);
const throttledEstimate = (trip: Parameters<typeof trips.estimate>[0]) => {
  const next = tripQueue.then(async () => {
    const started = Date.now();
    const snapshot = await trips.estimate(trip, tripLog);
    // A cached lane answers in a few milliseconds and needs no gap.
    const took = Date.now() - started;
    if (took > 150) await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_600 - took)));
    return snapshot;
  });
  tripQueue = next;
  return next;
};
const dataset = await buildDataset({
  now: today,
  days: 60,
  seed: 20261001,
  carriers: [...realCarriers, ...invented],
  lanes,
  unmetLanes,
  liveLoads,
  estimate: throttledEstimate,
  noticeEmail: env.DEMO_NOTICE_EMAIL ?? null,
});

// Batched multi-row inserts; every value goes through the sql tag's escaping.
async function insert(table: string, rows: Row[], casts: Record<string, string> = {}) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  for (let i = 0; i < rows.length; i += 400) {
    const values = rows
      .slice(i, i + 400)
      .map((row) => `(${columns.map((c) => sql`${row[c] ?? null}`.text + (casts[c] ?? "")).join(", ")})`)
      .join(", ");
    await run({ text: `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}` });
  }
}

const counts = Object.entries(dataset)
  .map(([table, rows]) => `${rows.length} ${table}`)
  .join(", ");
if (process.argv.includes("--dry-run")) {
  const sample = dataset.holds.find((h) => dataset.offers.filter((o) => o.call_id === h.call_id).length >= 2)?.call_id;
  for (const t of dataset.transcripts.filter((t) => t.call_id === sample)) console.log(`${String(t.at).slice(11, 19)} ${String(t.role).padEnd(7)} ${t.text}`);
  console.log(`dry run, nothing written: ${counts}`);
  process.exit(0);
}

await teardown();
await insert("calls", dataset.calls);
await insert("offers", dataset.offers);
await insert("holds", dataset.holds, { trip: "::jsonb" });
await insert("load_searches", dataset.searches);
await insert("truck_capacity", dataset.capacity, { free_date: "::date" });
await insert("interventions", dataset.interventions);
await insert("call_events", dataset.events);
await insert("call_transcripts", dataset.transcripts);

console.log(`seeded ${counts}`);
