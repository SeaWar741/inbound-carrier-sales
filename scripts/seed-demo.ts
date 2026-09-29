// Fills Twin with fake carriers, calls, offers and holds so the dashboard and the inbox have
// something to show. Every row is marked (call ids `demo-`, load ids `DM`) and the seed runs its
// own teardown first, so a rerun never duplicates.
// Usage: npm run seed:demo            (teardown, then seed)
//        npm run seed:demo -- --teardown
import { z } from "zod";
import { operatorTimeZone } from "../src/constants.ts";
import { TwinClient, sql, type SqlStatement } from "../src/infra/twin-client.ts";

const env = z.object({ HAPPYROBOT_API_KEY: z.string().min(1) }).parse(process.env);
const twin = new TwinClient({ apiKey: env.HAPPYROBOT_API_KEY });
const run = (statement: SqlStatement) => twin.query(statement, z.unknown());

async function teardown() {
  // Always filtered on the demo marks: never an unfiltered delete.
  for (const table of ["interventions", "call_events", "offers", "calls"]) {
    await run({ text: `DELETE FROM ${table} WHERE call_id LIKE 'demo-%'` });
  }
  await run({ text: "DELETE FROM holds WHERE call_id LIKE 'demo-%' OR load_id LIKE 'DM%'" });
}

await teardown();
if (process.argv.includes("--teardown")) {
  console.log("demo rows removed");
  process.exit(0);
}

type Lane = [string, string, string, string, string, string, number, string];
const lanes: Lane[] = [
  ["Chicago", "IL", "60601", "Dallas", "TX", "75201", 925, "DRY VAN"],
  ["Atlanta", "GA", "30303", "Nashville", "TN", "37203", 250, "REEFER"],
  ["Los Angeles", "CA", "90012", "Phoenix", "AZ", "85004", 370, "DRY VAN"],
  ["Denver", "CO", "80202", "Kansas City", "MO", "64105", 605, "FLATBED"],
  ["Houston", "TX", "77002", "Memphis", "TN", "38103", 565, "REEFER"],
  ["Columbus", "OH", "43215", "Charlotte", "NC", "28202", 425, "DRY VAN"],
  ["Seattle", "WA", "98104", "Salt Lake City", "UT", "84101", 840, "FLATBED"],
  ["Indianapolis", "IN", "46204", "Minneapolis", "MN", "55401", 590, "DRY VAN"],
  ["Philadelphia", "PA", "19103", "Pittsburgh", "PA", "15222", 305, "REEFER"],
  ["Miami", "FL", "33101", "Atlanta", "GA", "30303", 660, "REEFER"],
  ["Portland", "OR", "97204", "Los Angeles", "CA", "90012", 965, "DRY VAN"],
  ["Dallas", "TX", "75201", "Denver", "CO", "80202", 790, "FLATBED"],
];

// The TMS writes pickup times as a YYYYMMDDHHMMSS wall clock in the desk's zone.
const wallClock = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: operatorTimeZone, dateStyle: "short", timeStyle: "medium" })
    .format(date)
    .replaceAll(/\D/g, "");
const roundTo25 = (value: number) => Math.round(value / 25) * 25;
const ago = (hours: number) => `now() - ${hours} * interval '1 hour'`;

const calls: string[] = [];
const offers: string[] = [];
const holds: string[] = [];
const events: string[] = [];
let booked = 0;

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
    const pickupAt = wallClock(new Date(Date.now() + (latest ? pickupOffset : 48) * 3_600_000));
    const rounds = 1 + ((i + j) % 3);
    const result = latest && outcome !== "lost" ? outcome : "lost";

    calls.push(
      sql`(${callId}, ${String(8000000 + i)}, ${mc}, TRUE, TRUE, ${name}, `.text + ago(hoursAgo) + ")",
    );
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
      const at = hoursAgo - 0.05 - round * 0.03;
      offers.push(
        sql`(${callId}, ${loadId}, ${round}, ${ask}, ${decision}, ${rateToSay}, ${posted}, ${maxBuy},
          ${oCity}, ${oState}, ${oZip}, ${dCity}, ${dState}, ${dZip}, ${equipment}, ${miles}, ${pickupAt}, `.text +
          ago(at) +
          ")",
      );
      events.push(
        sql`(${callId}, 'evaluate_offer', ${`${decision === "accept" ? "Accept" : decision === "reject" ? "Reject" : "Counter"} round ${round}: carrier asks $${ask.toLocaleString("en-US")}`}, 'ok', `.text +
          ago(at) +
          ")",
      );
      ask = Math.max(roundTo25(ask * 0.95), posted);
    }

    if (result !== "lost") {
      const agreed = roundTo25(Math.min(ask, maxBuy));
      const status = result === "held" ? "held" : "booked";
      holds.push(
        sql`(${callId}, ${loadId}, ${mc}, ${agreed}, ${status}, ${status === "booked" ? `DMB-${nn}` : null}, ${posted}, ${maxBuy}, `.text +
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

await run({
  text: `INSERT INTO calls (call_id, dot_number, mc_number, eligible, verified, carrier_name, created_at) VALUES ${calls.join(", ")}`,
});
await run({
  text: `INSERT INTO offers (call_id, load_id, round, carrier_ask, decision, rate_to_say, posted_rate, max_buy,
    origin_city, origin_state, origin_zip, destination_city, destination_state, destination_zip, equipment, miles, pickup_at, created_at)
    VALUES ${offers.join(", ")}`,
});
await run({
  text: `INSERT INTO holds (call_id, load_id, mc_number, agreed_rate, status, booking_ref, posted_rate, max_buy, created_at, updated_at)
    VALUES ${holds.join(", ")}`,
});
await run({ text: `INSERT INTO call_events (call_id, tool, summary, status, created_at) VALUES ${events.join(", ")}` });
console.log(`seeded ${calls.length} calls, ${offers.length} offers, ${holds.length} holds, ${events.length} events`);
