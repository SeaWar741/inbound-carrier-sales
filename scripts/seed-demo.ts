// Fills Twin with fake carriers, calls, offers and holds so the dashboard and the inbox have
// something to show. Every row is marked (call ids `demo-`, load ids `DM`) and the seed runs its
// own teardown first, so a rerun never duplicates.
// Usage: npm run seed:demo            (teardown, then seed)
//        npm run seed:demo -- --teardown
import { z } from "zod";
import { operatorTimeZone } from "../src/constants.ts";
import { TripEstimator } from "../src/infra/trip-estimator.ts";
import { TwinClient, sql, type SqlStatement } from "../src/infra/twin-client.ts";

const env = z
  .object({
    HAPPYROBOT_API_KEY: z.string().min(1),
    // Without either key every demo hold is stored without a trip, like create_hold does.
    EIA_API_KEY: z.string().min(1).optional(),
    ORS_API_KEY: z.string().min(1).optional(),
  })
  .parse(process.env);
const twin = new TwinClient({ apiKey: env.HAPPYROBOT_API_KEY });
const run = (statement: SqlStatement) => twin.query(statement, z.unknown());

async function teardown() {
  // Always filtered on the demo marks: never an unfiltered delete.
  for (const table of ["interventions", "call_events", "offers", "load_searches", "calls"]) {
    await run({ text: `DELETE FROM ${table} WHERE call_id LIKE 'demo-%'` });
  }
  await run({ text: "DELETE FROM holds WHERE call_id LIKE 'demo-%'" });
}

await teardown();
if (process.argv.includes("--teardown")) {
  console.log("demo rows removed");
  process.exit(0);
}

type Lane = [string, string, string, string, string, string, number, string];
const lanes: Lane[] = [
  ["Chicago", "IL", "60601", "Dallas", "TX", "75201", 925, "DRY_VAN"],
  ["Atlanta", "GA", "30303", "Nashville", "TN", "37203", 250, "REEFER"],
  ["Los Angeles", "CA", "90012", "Phoenix", "AZ", "85004", 370, "DRY_VAN"],
  ["Denver", "CO", "80202", "Kansas City", "MO", "64105", 605, "FLATBED"],
  ["Houston", "TX", "77002", "Memphis", "TN", "38103", 565, "REEFER"],
  ["Columbus", "OH", "43215", "Charlotte", "NC", "28202", 425, "DRY_VAN"],
  ["Seattle", "WA", "98104", "Salt Lake City", "UT", "84101", 840, "FLATBED"],
  ["Indianapolis", "IN", "46204", "Minneapolis", "MN", "55401", 590, "DRY_VAN"],
  ["Philadelphia", "PA", "19103", "Pittsburgh", "PA", "15222", 305, "REEFER"],
  ["Miami", "FL", "33101", "Atlanta", "GA", "30303", 660, "REEFER"],
  ["Portland", "OR", "97204", "Los Angeles", "CA", "90012", 965, "DRY_VAN"],
  ["Dallas", "TX", "75201", "Denver", "CO", "80202", 790, "FLATBED"],
];

// The TMS writes pickup times as a YYYYMMDDHHMMSS wall clock in the desk's zone.
const wallClock = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: operatorTimeZone, dateStyle: "short", timeStyle: "medium" })
    .format(date)
    .replaceAll(/\D/g, "");
const roundTo25 = (value: number) => Math.round(value / 25) * 25;
const ago = (hours: number) => `now() - ${hours} * interval '1 hour'`;
// The fake loads carry no delivery appointment, so each gets a day per started 500 miles after
// pickup: a window one driver makes on every demo lane, as most real loads are.
const deliveryAfter = (pickup: Date, miles: number) => new Date(pickup.getTime() + Math.ceil(miles / 500) * 24 * 3_600_000);

// The estimator create_hold uses, so demo holds show the same trip a real hold would. A lane seen
// before reuses its route; with ORS over quota the fallback speed applies and tolls are left out.
const trips = TripEstimator.fromConfig(env);
const tripLog = { warn: (details: object, message: string) => console.warn(message, details) };

const calls: string[] = [];
const offers: string[] = [];
const holds: string[] = [];
const events: string[] = [];
const searches: string[] = [];
let booked = 0;

// A search that reached the board, as load_searches stores it: NULL destination or equipment asked for any.
const search = (callId: string, hoursAgo: number, lane: (string | null)[], results: number) => {
  const [oCity, oState, oZip, dCity, dState, dZip, equipment] = lane;
  searches.push(
    sql`(${callId}, ${oCity ?? null}, ${oState ?? null}, ${oZip ?? null}, ${dCity ?? null}, ${dState ?? null}, ${dZip ?? null}, ${equipment ?? null}, ${results}, `.text +
      ago(hoursAgo - 0.04) +
      ")",
  );
};

for (let i = 1; i <= 24; i++) {
  const nn = String(i).padStart(2, "0");
  const mc = String(9000000 + i);
  const name = `Demo Freight ${nn}`;
  const callCount = 1 + (i % 3);
  // 3 carriers wait on a rep, 15 booked a load, 6 walked away.
  const outcome = i % 8 === 0 ? "held" : i % 8 <= 5 ? "booked" : "lost";
  // Of the 15 booked loads, 3 picked up long ago (arrived), 8 in the last 15 h (mostly in transit), 4 ahead.
  const k = outcome === "booked" ? booked++ : -1;
  const pickupOffset = k < 0 ? 24 + i : k < 3 ? -30 - k * 5 : k < 11 ? -1 - (k - 3) * 2 : 6 + (k - 11) * 10;
  const latestAgo = outcome === "booked" && pickupOffset < 0 ? 6 - pickupOffset : 1 + ((i * 7) % 30);

  for (let j = 0; j < callCount; j++) {
    const latest = j === callCount - 1;
    const callId = `demo-${nn}-${j}`;
    const hoursAgo = latestAgo + (callCount - 1 - j) * 20;
    const [oCity, oState, oZip, dCity, dState, dZip, miles, equipment] = lanes[(i + j) % lanes.length]!;
    const loadId = `DM${nn}${j}`;
    const posted = roundTo25(miles * 2.4);
    const maxBuy = roundTo25(posted * 1.1);
    const pickupDate = new Date(Date.now() + (latest ? pickupOffset : 48) * 3_600_000);
    const pickupAt = wallClock(pickupDate);
    const rounds = 1 + ((i + j) % 3);
    const result = latest && outcome !== "lost" ? outcome : "lost";

    calls.push(
      sql`(${callId}, ${String(8000000 + i)}, ${mc}, TRUE, TRUE, ${name}, `.text + ago(hoursAgo) + ")",
    );
    search(callId, hoursAgo, [oCity, oState, oZip, dCity, dState, dZip, equipment], 1);
    events.push(
      sql`(${callId}, 'verify_carrier', ${`Verified MC ${mc}, ${name}`}, 'ok', `.text + ago(hoursAgo) + ")",
      sql`(${callId}, 'search_loads', ${`Found ${loadId} ${oCity}, ${oState} to ${dCity}, ${dState}`}, 'ok', `.text +
        ago(hoursAgo - 0.05) +
        ")",
    );

    let ask = roundTo25(posted * 1.25);
    for (let round = 1; round <= rounds; round++) {
      const last = round === rounds;
      const decision = last ? (result === "lost" ? "reject" : "accept") : "counter";
      const rateToSay = decision === "accept" ? ask : roundTo25(posted + (maxBuy - posted) * (round / 3));
      // We only counter or reject an ask above what we offer, so the decayed ask never lands below it.
      const carrierAsk = decision === "accept" ? ask : Math.max(ask, rateToSay + 25);
      const at = hoursAgo - 0.05 - round * 0.03;
      offers.push(
        sql`(${callId}, ${loadId}, ${round}, ${carrierAsk}, ${decision}, ${rateToSay}, ${posted}, ${maxBuy},
          ${oCity}, ${oState}, ${oZip}, ${dCity}, ${dState}, ${dZip}, ${equipment}, ${miles}, ${pickupAt}, `.text +
          ago(at) +
          ")",
      );
      events.push(
        sql`(${callId}, 'evaluate_offer', ${`${decision === "accept" ? "Accept" : decision === "reject" ? "Reject" : "Counter"} round ${round}: carrier asks $${carrierAsk.toLocaleString("en-US")}`}, 'ok', `.text +
          ago(at) +
          ")",
      );
      ask = Math.max(roundTo25(ask * 0.95), posted);
    }

    if (result !== "lost") {
      const agreed = roundTo25(Math.min(ask, maxBuy));
      const status = result === "held" ? "held" : "booked";
      // Same inputs estimateLoadTrip builds from a TMS load: its lane, miles and window at the agreed rate.
      const estimate = await trips.estimate(
        {
          origin: { zip: oZip, state: oState },
          destination: { zip: dZip, state: dState },
          miles,
          pickupAt: pickupDate,
          deliveryAt: deliveryAfter(pickupDate, miles),
          rate: agreed,
        },
        tripLog,
      );
      const trip = estimate ? JSON.stringify(estimate) : null;
      holds.push(
        sql`(${callId}, ${loadId}, ${mc}, ${agreed}, ${status}, ${status === "booked" ? `DMB-${nn}` : null}, ${posted}, ${maxBuy}, ${trip}::jsonb, `.text +
          `${ago(hoursAgo - 0.2)}, ${ago(hoursAgo - 0.2)})`,
      );
      events.push(
        sql`(${callId}, 'create_hold', ${`${status === "booked" ? "Booked" : "Holding"} load ${loadId} at $${agreed.toLocaleString("en-US")}`}, 'ok', `.text +
          ago(hoursAgo - 0.2) +
          ")",
      );
    }
  }
}

// History for the carrier network, on carriers that exist only in past weeks so every view has rows:
// days ago per call and whether it booked. Each call searched, got one offer on its lane and either
// booked it or walked away. The Top carriers run lane 1 (Atlanta REEFER) and book it more than twice,
// so they read as Growth only while the TMS board has an open GA REEFER load; the seed does not post one.
type History = { lane: number; calls: [daysAgo: number, booked: boolean][] };
const history: History[] = [
  // At risk: booked 3 to 7 weeks ago, silent in the last 14 days.
  ...[0, 1, 2, 3].map((n) => ({ lane: 4 + n, calls: [[22 + n * 5, true], [26 + n * 5, false], [30 + n * 5, true], [34 + n * 5, false]] as History["calls"] })),
  // At risk: calls down, 1 in the last 14 days against 6 in the 14 days before.
  ...[0, 1].map((n) => ({ lane: 8 + n, calls: [[3, false], [15, true], [17, false], [19, false], [21, false], [24, false], [27 - n, false]] as History["calls"] })),
  // Top: 3 of 4 negotiated calls booked in the last 30 days.
  ...[0, 1, 2].map((n) => ({ lane: 1, calls: [[2 + n, true], [6 + n, true], [10 + n, false], [20 + n, true]] as History["calls"] })),
];
history.forEach(({ lane, calls: past }, h) => {
  const nn = String(25 + h);
  const mc = String(9000000 + 25 + h);
  const name = `Demo Freight ${nn}`;
  const [oCity, oState, oZip, dCity, dState, dZip, miles, equipment] = lanes[lane]!;
  const posted = roundTo25(miles * 2.4);
  const maxBuy = roundTo25(posted * 1.1);
  past.forEach(([daysAgo, didBook], j) => {
    const callId = `demo-h${nn}-${j}`;
    const loadId = `DMH${nn}${j}`;
    const hoursAgo = daysAgo * 24;
    const pickupAt = wallClock(new Date(Date.now() - (hoursAgo - 48) * 3_600_000));
    calls.push(sql`(${callId}, ${String(8000000 + 25 + h)}, ${mc}, TRUE, TRUE, ${name}, `.text + ago(hoursAgo) + ")");
    search(callId, hoursAgo, [oCity, oState, oZip, dCity, dState, dZip, equipment], 1);
    // A lost call is a carrier holding out above our ceiling after we offered max buy.
    const carrierAsk = didBook ? posted : Math.max(roundTo25(maxBuy * 1.1), maxBuy + 25);
    offers.push(
      sql`(${callId}, ${loadId}, 1, ${carrierAsk}, ${didBook ? "accept" : "reject"}, ${didBook ? posted : maxBuy}, ${posted}, ${maxBuy},
        ${oCity}, ${oState}, ${oZip}, ${dCity}, ${dState}, ${dZip}, ${equipment}, ${miles}, ${pickupAt}, `.text +
        ago(hoursAgo - 0.1) +
        ")",
    );
    if (didBook) {
      holds.push(
        sql`(${callId}, ${loadId}, ${mc}, ${posted}, 'booked', ${`DMB-H${nn}${j}`}, ${posted}, ${maxBuy}, NULL::jsonb, `.text +
          `${ago(hoursAgo - 0.2)}, ${ago(hoursAgo - 0.2)})`,
      );
    }
  });
});

// Unmet demand for the radar: extra calls from existing carriers whose searches found nothing.
// REEFER Houston to Atlanta by 4 carriers, FLATBED out of Denver to anywhere by 2, spread over two weeks.
const houstonAtlantaReefer = ["Houston", "TX", "77002", "Atlanta", "GA", "30303", "REEFER"];
const denverFlatbedAnywhere = ["Denver", "CO", "80202", null, null, null, "FLATBED"];
const unmet: [carrier: number, daysAgo: number, lane: (string | null)[]][] = [
  [2, 1, houstonAtlantaReefer],
  [2, 4, houstonAtlantaReefer],
  [2, 9, houstonAtlantaReefer],
  [5, 2, houstonAtlantaReefer],
  [5, 10, houstonAtlantaReefer],
  [11, 3, houstonAtlantaReefer],
  [14, 11, houstonAtlantaReefer],
  [11, 6, houstonAtlantaReefer],
  [14, 5, houstonAtlantaReefer],
  [17, 1, denverFlatbedAnywhere],
  [17, 8, denverFlatbedAnywhere],
  [20, 5, denverFlatbedAnywhere],
];
unmet.forEach(([i, daysAgo, lane], k) => {
  const nn = String(i).padStart(2, "0");
  const callId = `demo-s${nn}-${k}`;
  calls.push(sql`(${callId}, ${String(8000000 + i)}, ${String(9000000 + i)}, TRUE, TRUE, ${`Demo Freight ${nn}`}, `.text + ago(daysAgo * 24) + ")");
  search(callId, daysAgo * 24, lane, 0);
});

await run({
  text: `INSERT INTO calls (call_id, dot_number, mc_number, eligible, verified, carrier_name, created_at) VALUES ${calls.join(", ")}`,
});
await run({
  text: `INSERT INTO offers (call_id, load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy,
    origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, miles, pickup_at, created_at)
    VALUES ${offers.join(", ")}`,
});
await run({
  text: `INSERT INTO holds (call_id, load_id, mc_number, agreed_rate, status, booking_ref, posted_rate, max_buy, trip, created_at, updated_at)
    VALUES ${holds.join(", ")}`,
});
await run({
  text: `INSERT INTO load_searches (call_id, origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, results, created_at)
    VALUES ${searches.join(", ")}`,
});
await run({ text: `INSERT INTO call_events (call_id, tool, summary, status, created_at) VALUES ${events.join(", ")}` });
console.log(`seeded ${calls.length} calls, ${offers.length} offers, ${holds.length} holds, ${searches.length} searches, ${events.length} events`);
