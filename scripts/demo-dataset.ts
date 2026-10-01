// Builds the demo dataset: weeks of carrier calls with the rows the adapter would have written and the
// conversation the agent would have had. Deterministic for a seed, and free of I/O: the seed script
// passes in the carriers, the lanes and the live board (read from FMCSA and the TMS) and the trip
// estimator, and writes what comes back. Rates and counters come from evaluateOffer, event summaries
// from the call-events plugin, and the agent says the tools' own messages, so every view agrees.
import { evaluateOffer, finalRound, scheduledCounter } from "../src/domain/negotiation.ts";
import type { TripSnapshot } from "../src/domain/trip-estimate.ts";
import { summarize } from "../src/plugins/call-events.ts";

export type Place = { city: string; state: string; zip: string };
export type Equipment = "DRY_VAN" | "REEFER" | "FLATBED" | "STEP_DECK" | "POWER_ONLY";

// A carrier the desk talks to. `real` ones come from FMCSA with their own verdict; the rest are invented.
export type DemoCarrier = {
  mc: string;
  dot: string;
  name: string;
  real: boolean;
  status: "ok" | "not_eligible" | "needs_review";
  equipment: Equipment;
  home: Place;
  // The dispatcher who calls, as they introduce themselves.
  contact: string;
  // How often and when they call: top and regular all along, lapsed only weeks ago, new only lately.
  cadence: "top" | "regular" | "occasional" | "lapsed" | "new";
};

// A lane the desk moves freight on, with the freight details a load on it carries.
export type LaneTemplate = {
  origin: Place;
  destination: Place;
  miles: number;
  equipment: Equipment;
  ratePerMile: number;
  maxBuyRatio: number;
  commodity: string;
  weight: number;
  pieces: number;
  notes: string;
};

// A load on the real board now (TMS LOAD_GET): used for the few holds still waiting on a rep, so
// confirming one from the tower books a load that exists.
export type LiveLoad = LaneTemplate & { loadId: string; rate: number; maxBuy: number; pickupAt: string; deliveryAt: string };

export type TripRequest = { origin: Place; destination: Place; miles: number; pickupAt: Date; deliveryAt: Date; rate: number };

export type DatasetInput = {
  now: Date;
  days: number;
  seed: number;
  carriers: DemoCarrier[];
  lanes: LaneTemplate[];
  // Lanes carriers ask for that the board does not cover; half of the searches that find nothing ask for one.
  unmetLanes: LaneTemplate[];
  liveLoads: LiveLoad[];
  estimate: (trip: TripRequest) => Promise<TripSnapshot | null>;
  // Where hold notices for demo calls would go; null leaves demo calls without a contact.
  noticeEmail: string | null;
};

export type Row = Record<string, string | number | boolean | null>;
export type Dataset = {
  calls: Row[];
  events: Row[];
  offers: Row[];
  holds: Row[];
  searches: Row[];
  capacity: Row[];
  interventions: Row[];
  transcripts: Row[];
};

// --- randomness ---------------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = ReturnType<typeof makeRng>;
function makeRng(seed: number) {
  const next = mulberry32(seed);
  const rng = {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(list: readonly T[]): T => {
      if (list.length === 0) throw new Error("pick from an empty list");
      return list[Math.floor(next() * list.length)] as T;
    },
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [value, w] of entries) {
        roll -= w;
        if (roll < 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
  };
  return rng;
}

// --- how numbers, dates and places are spoken ---------------------------------------------------

const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const under100 = (n: number): string => (n < 20 ? ones[n]! : `${tens[Math.floor(n / 10)]}${n % 10 ? `-${ones[n % 10]}` : ""}`);
const pairTail = (n: number) => (n < 10 ? `oh ${ones[n]}` : under100(n));

// The way the prompt tells the agent to say numbers: in pairs, like a dispatcher.
export function spoken(n: number): string {
  if (n < 100) return under100(n);
  if (n % 1000 === 0) return `${under100(n / 1000)} thousand`;
  if (n < 1000) return n % 100 === 0 ? `${ones[n / 100]} hundred` : `${ones[Math.floor(n / 100)]} ${pairTail(n % 100)}`;
  if (n < 10_000) return n % 100 === 0 ? `${under100(n / 100)} hundred` : `${under100(Math.floor(n / 100))} ${pairTail(n % 100)}`;
  return `${under100(Math.floor(n / 1000))} thousand ${spoken(n % 1000)}`;
}

const ordinals = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const deskZone = "America/Chicago";
const deskParts = (at: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: deskZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
};

function spokenTime(at: Date): string {
  const { hour, minute } = deskParts(at);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const clock = minute === 0 ? ones[h12]! : `${ones[h12]} ${pairTail(minute)}`;
  const period = hour < 12 ? "in the morning" : hour < 17 ? "in the afternoon" : hour < 21 ? "in the evening" : "at night";
  return `${clock} ${period}`;
}
const spokenDate = (at: Date) => {
  const { month, day } = deskParts(at);
  return `${months[month - 1]} ${ordinals[day]}`;
};

// The TMS wall clock: YYYYMMDDHHMMSS in the desk's zone.
export function wallClock(at: Date): string {
  const { year, month, day, hour, minute } = deskParts(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${year}${two(month)}${two(day)}${two(hour)}${two(minute)}00`;
}

const stateNames: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const placeSpoken = (p: Place) => `${p.city}, ${stateNames[p.state] ?? p.state}`;
const equipmentSpoken: Record<Equipment, string> = { DRY_VAN: "dry van", REEFER: "reefer", FLATBED: "flatbed", STEP_DECK: "step deck", POWER_ONLY: "power only" };
const equipmentCarrierSays: Record<Equipment, string[]> = {
  DRY_VAN: ["Dry van.", "53 foot dry van.", "Van.", "I got a dry van."],
  REEFER: ["Reefer.", "Reefer, 53 footer.", "I'm running a reefer.", "Reefer unit."],
  FLATBED: ["Flatbed.", "48 foot flatbed.", "Flat.", "I'm on a flatbed, got tarps and straps."],
  STEP_DECK: ["Step deck.", "Step deck, 53.", "I got a step deck."],
  POWER_ONLY: ["Power only.", "Just the tractor, power only.", "Power only, no trailer."],
};
const carrierMoney = (rng: Rng, usd: number) => (rng.chance(0.55) ? `$${usd.toLocaleString("en-US")}` : spoken(usd));

// --- one call -------------------------------------------------------------------------------------

type Speaker = "agent" | "carrier";

class CallScript {
  readonly entries: { role: Speaker | "tool" | "signal"; text: string; at: Date }[] = [];
  readonly events: { tool: string; summary: string | null; status: string; at: Date }[] = [];
  readonly callId: string;
  readonly #rng: Rng;
  #ms: number;

  constructor(callId: string, start: Date, rng: Rng) {
    this.callId = callId;
    this.#rng = rng;
    this.#ms = start.getTime();
  }

  get now() {
    return new Date(this.#ms);
  }

  // Speaking takes about 14 characters a second plus a beat before the turn.
  say(role: Speaker, text: string) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
    this.#ms += Math.round((this.#rng.between(0.4, 1.4) + text.length / 14) * 1000);
    this.entries.push({ role, text, at: this.now });
  }

  // A tool call: logged where the operator wall sees it, timed like a webhook round trip.
  tool(tool: string, body: Record<string, unknown>, response: Record<string, unknown>, summary?: string | null) {
    this.#ms += Math.round(this.#rng.between(0.6, 2.2) * 1000);
    this.entries.push({ role: "tool", text: tool, at: this.now });
    const status = String(response.status);
    this.events.push({ tool, summary: summary !== undefined ? summary : summarize(tool, body, response), status, at: this.now });
  }

  signal() {
    this.#ms += Math.round(this.#rng.between(0.5, 1.5) * 1000);
    this.entries.push({ role: "signal", text: "", at: this.now });
  }

  pause(seconds: number) {
    this.#ms += seconds * 1000;
  }
}

type Load = LaneTemplate & { loadId: string; rate: number; maxBuy: number; pickupAt: Date; deliveryAt: Date; live: boolean };

type Outcome =
  | "ineligible"
  | "needs_review"
  | "otp_locked"
  | "no_loads_capacity"
  | "no_loads"
  | "passed"
  | "lost"
  | "booked"
  | "released"
  | "human"
  | "callback";

// --- the generator --------------------------------------------------------------------------------

export async function buildDataset(input: DatasetInput): Promise<Dataset> {
  const rng = makeRng(input.seed);
  const out: Dataset = { calls: [], events: [], offers: [], holds: [], searches: [], capacity: [], interventions: [], transcripts: [] };
  const nowMs = input.now.getTime();
  const dayMs = 86_400_000;
  let loadSeq = 20_000 + rng.int(0, 400);
  const nextLoadId = () => `LD${String((loadSeq += rng.int(1, 4)))}`;
  let bookingSeq = 4_100_000 + rng.int(0, 9_000);
  const liveFree = [...input.liveLoads];
  // Trucks we notified, by MC: a later call from that carrier is the callback.
  const notices = new Map<string, { loadId: string; at: Date; load: Load }>();
  const callsPerCarrier = new Map<string, number>();
  const tripCache = new Map<string, Promise<TripSnapshot | null>>();

  // Volume: weekdays heavy, weekends light, growing about 50% over the window; business hours, desk time.
  const starts: Date[] = [];
  for (let daysAgo = input.days - 1; daysAgo >= 0; daysAgo--) {
    const dayStart = new Date(nowMs - daysAgo * dayMs);
    const weekday = new Date(dayStart.toLocaleString("en-US", { timeZone: deskZone })).getDay();
    const weekFactor = weekday === 0 ? 0.2 : weekday === 6 ? 0.35 : weekday === 5 ? 0.9 : 1;
    const growth = 0.8 + 0.45 * (1 - daysAgo / input.days);
    const count = Math.round(12 * weekFactor * growth * rng.between(0.8, 1.2));
    for (let i = 0; i < count; i++) {
      const hour = rng.weighted([[6, 3], [7, 8], [8, 10], [9, 10], [10, 9], [11, 7], [12, 5], [13, 7], [14, 8], [15, 7], [16, 5], [17, 3], [18, 1]] as const);
      const { year, month, day } = deskParts(dayStart);
      const start = deskTime(year, month, day, hour, rng.int(0, 59), rng.int(0, 59));
      if (start.getTime() < nowMs - 4 * 60_000) starts.push(start);
    }
  }
  starts.sort((a, b) => a.getTime() - b.getTime());

  const eligibleCarriers = input.carriers.filter((c) => c.status === "ok");
  const otherCarriers = input.carriers.filter((c) => c.status !== "ok");
  const weightOf = (c: DemoCarrier, daysAgo: number) => {
    if (c.cadence === "lapsed") return daysAgo > 24 ? 3 : 0;
    if (c.cadence === "new") return daysAgo < 12 ? 2.5 : 0;
    return { top: 6, regular: 2.5, occasional: 0.8 }[c.cadence];
  };

  for (const [index, start] of starts.entries()) {
    const daysAgo = (nowMs - start.getTime()) / dayMs;
    const carrier =
      otherCarriers.length > 0 && rng.chance(0.07)
        ? rng.pick(otherCarriers)
        : rng.weighted(eligibleCarriers.map((c) => [c, weightOf(c, daysAgo)] as const).filter(([, w]) => w > 0));
    const callId = `demo-${String(index + 1).padStart(4, "0")}`;
    const nth = (callsPerCarrier.get(carrier.mc) ?? 0) + 1;
    callsPerCarrier.set(carrier.mc, nth);
    const script = new CallScript(callId, start, rng);
    const recent = nowMs - start.getTime() < 6 * 3_600_000;
    const notice = notices.get(carrier.mc);
    const outcome: Outcome =
      carrier.status === "not_eligible"
        ? "ineligible"
        : carrier.status === "needs_review"
          ? "needs_review"
          : notice && start.getTime() - notice.at.getTime() < 3 * dayMs && start < notice.load.pickupAt
            ? "callback"
            : rng.weighted([
                ["booked", carrier.cadence === "top" ? 34 : 24],
                ["lost", 17],
                ["passed", 11],
                ["no_loads_capacity", 10],
                ["no_loads", 10],
                ["human", 4],
                ["released", 3],
                ["otp_locked", 3],
              ] as const);
    if (outcome === "callback") notices.delete(carrier.mc);

    const call = await playCall({ rng, input, script, carrier, outcome, nth, recent, nextLoadId, liveFree, tripCache, notice, out, nextBooking: () => `BK${(bookingSeq += rng.int(3, 40))}` });
    if (call.notice) notices.set(carrier.mc, call.notice);

    out.calls.push({
      call_id: callId,
      dot_number: carrier.dot,
      mc_number: carrier.mc,
      eligible: carrier.status === "ok",
      verified: call.verified,
      otp_attempts: call.otpAttempts,
      otp_sends: call.verified || call.otpAttempts > 0 ? 1 : 0,
      carrier_name: carrier.name,
      otp_channel: call.verified ? "email" : null,
      otp_destination: call.verified ? input.noticeEmail : null,
      created_at: start.toISOString(),
    });
    for (const e of script.events) out.events.push({ call_id: callId, tool: e.tool, summary: e.summary, status: e.status, created_at: e.at.toISOString() });
    script.entries.forEach((e, seq) => out.transcripts.push({ call_id: callId, seq: seq + 1, role: e.role, text: e.text, at: e.at.toISOString() }));
  }
  return out;
}

// A desk wall-clock moment as an instant (the desk's offset applied, DST included).
function deskTime(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = (at: number) => {
    const p = deskParts(new Date(at));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(at / 60_000) * 60_000;
  };
  return new Date(guess - offset(guess - offset(guess)));
}

type PlayInput = {
  rng: Rng;
  input: DatasetInput;
  script: CallScript;
  carrier: DemoCarrier;
  outcome: Outcome;
  nth: number;
  recent: boolean;
  nextLoadId: () => string;
  nextBooking: () => string;
  liveFree: LiveLoad[];
  tripCache: Map<string, Promise<TripSnapshot | null>>;
  notice: { loadId: string; at: Date; load: Load } | undefined;
  out: Dataset;
};

type Played = { verified: boolean; otpAttempts: number; notice?: { loadId: string; at: Date; load: Load } };

const openers = [
  "Thanks for calling HappyRobot Logistics, this is Pablo. Quick heads up, you're on a recorded line and I'm an AI assistant. What's your MC number?",
  "HappyRobot Logistics, Pablo speaking. This call is recorded and I'm an AI assistant. Can I get your MC number?",
  "Hey there, this is Pablo with HappyRobot Logistics. Just so you know, I'm an AI assistant and the line is recorded. What's your MC?",
];
const hellos = (c: DemoCarrier) => [
  `Hey, this is ${c.contact} with ${shortName(c.name)}, looking for a load.`,
  `Yeah, hi, ${c.contact} here from ${shortName(c.name)}. I'm calling about freight.`,
  `Morning. ${c.contact}, ${shortName(c.name)}. You got anything moving?`,
  `Hi, it's ${c.contact} over at ${shortName(c.name)}. Trying to find a reload.`,
];
const shortName = (name: string) => name.replace(/\b(LLC|INC|CORP|CO|LTD)\.?$/i, "").replace(/,\s*$/, "").trim().split(/\s+/).slice(0, 3).join(" ");
const titleCase = (name: string) => name.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/\bLlc\b/g, "LLC").replace(/\bInc\b/g, "Inc");
const mcSpoken = (rng: Rng, mc: string) => (rng.chance(0.5) ? `It's ${mc}.` : `MC ${mc.split("").join(" ")}.`);
const codeSpoken = (rng: Rng) => {
  const digits = Array.from({ length: 6 }, () => rng.int(0, 9));
  return rng.chance(0.5) ? `${digits.slice(0, 3).join(" ")}, ${digits.slice(3).join(" ")}.` : `It's ${digits.join("")}.`;
};

async function playCall(p: PlayInput): Promise<Played> {
  const { rng, script, carrier } = p;
  script.say("agent", rng.pick(openers));
  if (rng.chance(0.5)) {
    script.say("carrier", `${rng.pick(hellos(carrier))} ${mcSpoken(rng, carrier.mc)}`);
  } else {
    script.say("carrier", rng.pick(hellos(carrier)));
    script.say("agent", rng.pick(["Sure thing. What's your MC number?", "Happy to help. Can I get your MC?"]));
    script.say("carrier", mcSpoken(rng, carrier.mc));
  }

  // 1. Carrier number.
  const verifyBody = { mcNumber: carrier.mc };
  if (carrier.status === "not_eligible") {
    script.tool("verify_carrier", verifyBody, { status: "not_eligible" });
    script.say("agent", "I'm sorry, based on FMCSA records this carrier isn't eligible to book loads with us right now. Thanks for calling, and take care.");
    script.say("carrier", rng.pick(["Huh. Alright, I'll look into it.", "Okay, thanks.", "Really? Okay, I'll call FMCSA."]));
    return { verified: false, otpAttempts: 0 };
  }
  if (carrier.status === "needs_review") {
    script.tool("verify_carrier", verifyBody, { status: "needs_review" });
    script.say("agent", "I couldn't confirm everything automatically, so a team member will need to review this carrier. I can have someone call you back once it's checked. Does that work?");
    script.say("carrier", rng.pick(["Yeah, that's fine.", "Sure, have them call me.", "Okay, whatever you need."]));
    script.say("agent", "Perfect, someone from the team will reach out. Thanks for calling.");
    return { verified: false, otpAttempts: 0 };
  }
  script.tool("verify_carrier", verifyBody, { status: "ok" });
  script.say("agent", `I've got you as ${carrier.real ? titleCase(carrier.name) : carrier.name}, is that right?`);
  script.say("carrier", rng.pick(["Yep, that's us.", "That's right.", "Yes sir.", "Yeah, correct."]));

  // 2. Identity code.
  const domain = shortName(carrier.name).toLowerCase().split(/\s+/).slice(0, 2).join("").replace(/[^a-z]/g, "") || "carrier";
  script.say("agent", `Great. I'll send a six-digit code to the email we have on file, the one starting with d at ${domain} dot com. Sending it now.`);
  script.tool("send_otp", { channel: "email" }, { status: "ok" });
  script.say("agent", "I just emailed you a six-digit code. Can you read it back to me?");
  script.pause(rng.int(6, 25));
  if (p.outcome === "otp_locked") {
    for (let attempt = 1; attempt <= 3; attempt++) {
      script.say("carrier", codeSpoken(rng));
      script.tool("check_otp", {}, { status: attempt < 3 ? "wrong_code" : "locked" });
      script.say(
        "agent",
        attempt < 3
          ? `That code doesn't match. You have ${3 - attempt} ${3 - attempt === 1 ? "try" : "tries"} left.`
          : "That's too many attempts for this code. I can send you a new one.",
      );
    }
    script.say("carrier", rng.pick(["Forget it, I'll call back when I'm at the office.", "Nah, I'm driving, I'll call back later."]));
    script.say("agent", "No problem, call us anytime. Take care.");
    return { verified: false, otpAttempts: 3 };
  }
  let attempts = 1;
  if (rng.chance(0.12)) {
    script.say("carrier", codeSpoken(rng));
    script.tool("check_otp", {}, { status: "wrong_code" });
    script.say("agent", "That code doesn't match. You have 2 tries left.");
    attempts = 2;
  }
  script.say("carrier", codeSpoken(rng));

  // The callback: we told this carrier about a load, and the agent brings it up on its own.
  if (p.outcome === "callback" && p.notice) {
    const load = p.notice.load;
    script.tool("check_otp", {}, { status: "ok" });
    script.say("agent", `Thanks, you're verified. We sent you load ${load.loadId}, ${placeSpoken(load.origin)} to ${placeSpoken(load.destination)}. Want to go over it?`);
    script.say("carrier", rng.pick(["Yeah, that's the one I'm calling about.", "Yes, that's why I called.", "Yep, let's do it."]));
    script.tool("search_loads", { loadId: load.loadId }, { status: "ok" }, "Searching loads");
    await pitch(p, load);
    return { verified: true, otpAttempts: attempts, ...(await negotiate(p, load, "booked")) };
  }

  script.tool("check_otp", {}, { status: "ok" });
  script.say("agent", "Thanks, you're verified. Where are you empty?");

  // 3. Lane.
  const unmet = (p.outcome === "no_loads" || p.outcome === "no_loads_capacity") && p.input.unmetLanes.length > 0 && rng.chance(0.5);
  const lane = unmet ? rng.pick(p.input.unmetLanes) : laneFor(p);
  script.say("carrier", rng.pick([`I'm empty in ${lane.origin.city}, ${lane.origin.state}.`, `${lane.origin.city}, ${stateNames[lane.origin.state]}.`, `Sitting in ${lane.origin.city} right now.`]));
  script.say("agent", rng.pick(["Got it. What are you running?", "Okay. And what equipment?", "Sure thing. What kind of trailer?"]));
  script.say("carrier", rng.pick(equipmentCarrierSays[lane.equipment]));
  script.say("agent", "Any pickup date in mind?");
  const pickupDay = rng.chance(0.55) ? null : rng.pick(["today", "tomorrow"]);
  script.say("carrier", pickupDay === null ? rng.pick(["Whenever, any day works.", "No preference.", "Anything this week."]) : `${pickupDay === "today" ? "Today" : "Tomorrow"} if you can.`);

  const searchBody = { origin: { city: lane.origin.city, state: lane.origin.state } };
  const searchedAt = () => script.now.toISOString();
  if (p.outcome === "no_loads" || p.outcome === "no_loads_capacity") {
    const destination = unmet || rng.chance(0.4) ? lane.destination : null;
    script.tool("search_loads", searchBody, { status: "no_loads" });
    recordSearch(p, lane, destination, 0, searchedAt());
    script.say("agent", "I don't have any open loads on that lane right now. Would another lane or a different equipment work?");
    script.say("carrier", rng.pick(["Nah, that's what I'm running.", "Not really, I need to stay around here.", "No, I gotta head home after this."]));
    if (p.outcome === "no_loads") {
      script.say("agent", "Want me to keep your truck on file and send you a load if one opens up near where you'll be empty?");
      script.say("carrier", rng.pick(["No thanks, I'll just call back.", "Nah, I'm good."]));
      script.say("agent", "No problem. Anything else I can help you with?");
      script.say("carrier", "That's it, thanks.");
      script.say("agent", "Thanks for calling, drive safe.");
      return { verified: true, otpAttempts: attempts };
    }
    return { verified: true, otpAttempts: attempts, ...saveCapacity(p, lane) };
  }

  const load = makeLoad(p, lane, pickupDay);
  script.tool("search_loads", searchBody, { status: "ok" });
  recordSearch(p, lane, null, rng.int(1, 3), searchedAt());
  await pitch(p, load);
  if (p.outcome === "passed") {
    const reason = rng.weighted([
      ["window", 3],
      ["rate", 3],
      ["destination", 2],
    ] as const);
    script.say(
      "carrier",
      reason === "window"
        ? "That delivery's too tight for me, I'm solo."
        : reason === "rate"
          ? "Nah, that's too cheap for that lane. I'll pass."
          : `I don't want to go to ${stateNames[load.destination.state]}, I'd be stuck there.`,
    );
    script.say("agent", "Understood. Want me to keep your truck on file and send you a load if one opens up near where you'll be empty?");
    script.say("carrier", rng.pick(["Nah, I'll call back.", "No, I'm good."]));
    script.say("agent", "No problem. Anything else I can help you with?");
    script.say("carrier", "No, that's all.");
    script.say("agent", "Thanks for calling, take care.");
    return { verified: true, otpAttempts: attempts };
  }
  return { verified: true, otpAttempts: attempts, ...(await negotiate(p, load, p.outcome)) };
}

// A lane near the carrier's home in its equipment when there is one, else any lane in its equipment.
function laneFor(p: PlayInput): LaneTemplate {
  const own = p.input.lanes.filter((l) => l.equipment === p.carrier.equipment);
  const home = own.filter((l) => l.origin.state === p.carrier.home.state);
  const pool = home.length > 0 && p.rng.chance(0.6) ? home : own.length > 0 ? own : p.input.lanes;
  return p.rng.pick(pool);
}

function makeLoad(p: PlayInput, lane: LaneTemplate, pickupDay: string | null): Load {
  const { rng, script } = p;
  // The few holds still waiting on a rep use real board loads, so the tower's confirm books something real.
  if (p.recent && p.outcome === "booked") {
    const live = p.liveFree.find((l) => l.equipment === lane.equipment) ?? p.liveFree[0];
    if (live) {
      p.liveFree.splice(p.liveFree.indexOf(live), 1);
      return { ...live, pickupAt: new Date(live.pickupAt), deliveryAt: new Date(live.deliveryAt), live: true };
    }
  }
  const rate = Math.round((lane.miles * lane.ratePerMile * rng.between(0.92, 1.08)) / 25) * 25;
  const maxBuy = Math.round((rate * lane.maxBuyRatio) / 25) * 25;
  const leadHours = pickupDay === "today" ? rng.between(3, 9) : pickupDay === "tomorrow" ? rng.between(18, 30) : rng.between(6, 60);
  const pickup = new Date(Math.round((script.now.getTime() + leadHours * 3_600_000) / 900_000) * 900_000);
  // A day per started 500 miles plus a few hours: the window one driver makes, as on most real loads.
  const delivery = new Date(pickup.getTime() + (Math.ceil(lane.miles / 500) * 24 + rng.int(0, 6)) * 3_600_000);
  return { ...lane, loadId: p.nextLoadId(), rate, maxBuy, pickupAt: pickup, deliveryAt: delivery, live: false };
}

function recordSearch(p: PlayInput, lane: LaneTemplate, destination: Place | null, results: number, at: string) {
  p.out.searches.push({
    call_id: p.script.callId,
    origin_city: lane.origin.city,
    origin_state: lane.origin.state,
    origin_zip: lane.origin.zip,
    destination_city: destination?.city ?? null,
    destination_state: destination?.state ?? null,
    destination_zip: destination?.zip ?? null,
    equipment: lane.equipment,
    results,
    created_at: at,
  });
}

async function pitch(p: PlayInput, load: Load) {
  const { rng, script } = p;
  const notes = load.notes ? ` ${load.notes}` : "";
  script.say(
    "agent",
    `${rng.pick(["I've got", "Here's one:", "Okay, I have"])} ${placeSpoken(load.origin)} to ${placeSpoken(load.destination)}. Picks up ${spokenDate(load.pickupAt)} at ${spokenTime(load.pickupAt)}, delivers ${spokenDate(load.deliveryAt)} at ${spokenTime(load.deliveryAt)}. ${capitalized(equipmentSpoken[load.equipment])}, ${spoken(load.miles)} miles, about ${spoken(Math.round(load.weight / 1000))} thousand pounds of ${load.commodity.toLowerCase()}. Loadboard rate is ${spoken(load.rate)}.${notes}`,
  );
}

type Played2 = Omit<Played, "verified" | "otpAttempts">;

async function negotiate(p: PlayInput, load: Load, outcome: Outcome): Promise<Played2> {
  const { rng, script } = p;
  const callId = script.callId;
  // What the carrier would settle for: a booking walks away below its reservation, a loss holds out above max buy.
  const reservation =
    outcome === "lost" ? load.maxBuy + rng.int(2, 12) * 25 : Math.min(load.maxBuy, load.rate + Math.round(((load.maxBuy - load.rate) * rng.between(0, 1)) / 25) * 25);
  let ask = outcome === "lost" ? reservation + rng.int(2, 10) * 25 : Math.max(load.rate, reservation + rng.int(0, 8) * 25);
  const takesPosted = outcome !== "lost" && reservation === load.rate && rng.chance(0.6);
  let authorized = 0;
  let agreed: number | null = null;
  const pickupAt = wallClock(load.pickupAt);
  const askedEstimate = rng.chance(0.3);
  let human = false;

  const offer = (round: number, carrierAsk: number, decision: string, rateToSay: number | null) =>
    p.out.offers.push({
      call_id: callId,
      load_id: load.loadId,
      round,
      carrier_ask: carrierAsk,
      decision,
      rate_to_say: rateToSay,
      posted_rate: load.rate,
      max_buy: load.maxBuy,
      origin_city: load.origin.city,
      origin_state: load.origin.state,
      origin_zip: load.origin.zip,
      destination_city: load.destination.city,
      destination_state: load.destination.state,
      destination_zip: load.destination.zip,
      equipment: load.equipment,
      miles: load.miles,
      pickup_at: pickupAt,
      created_at: script.now.toISOString(),
    });

  if (takesPosted) {
    script.say("carrier", rng.pick(["I'll take it at that.", "Yeah, book it at the posted rate.", "That works, I'll take it."]));
    ask = load.rate;
  } else {
    script.say("carrier", rng.pick([`I'd need ${carrierMoney(rng, ask)} on that.`, `Can you do ${carrierMoney(rng, ask)}?`, `Gotta be ${carrierMoney(rng, ask)} for me to move it.`, `${carrierMoney(rng, ask)} and it's mine.`]));
  }

  for (let round = 1; round <= finalRound + 1; round++) {
    const evaluation = evaluateOffer({ postedRate: load.rate, maxBuy: load.maxBuy, carrierAsk: ask, round, authorizedUsd: authorized });
    const response = { status: "ok", decision: evaluation.decision, round };
    script.tool("evaluate_offer", { loadId: load.loadId, carrierAsk: ask }, response);
    offer(round, ask, evaluation.decision, evaluation.rateToSay);
    if (evaluation.decision === "accept") {
      script.say("agent", `${capitalized(spoken(evaluation.rateToSay))} works for us on this load. So that's ${placeSpoken(load.origin)} to ${placeSpoken(load.destination)} at ${spoken(evaluation.rateToSay)}.`);
      agreed = evaluation.rateToSay;
      break;
    }
    if (evaluation.decision === "reject") {
      script.say("agent", "I'm sorry, I can't get to that number on this load.");
      break;
    }
    const counter = evaluation.rateToSay;
    script.say("agent", evaluation.isFinalRound ? `${capitalized(spoken(counter))} is the best I can do on this load. Does that work for you?` : `I can do ${spoken(counter)} on this load. Does that work for you?`);

    // A rep watching the call sometimes nudges: a whisper, or a little room on this load.
    if (round === 1 && outcome !== "lost" && rng.chance(0.1)) {
      const amount = rng.pick([50, 75, 100]);
      authorized += amount;
      script.signal();
      p.out.interventions.push({ call_id: callId, kind: "authorization", load_id: load.loadId, amount_usd: amount, message: null, created_at: script.now.toISOString() });
    } else if (round === 1 && rng.chance(0.06)) {
      script.signal();
      p.out.interventions.push({
        call_id: callId,
        kind: "whisper",
        load_id: null,
        amount_usd: null,
        message: rng.pick(["Mention the quick pay option.", "Shipper loads fast, tell him no detention.", "Keep it friendly, he's a regular."]),
        created_at: script.now.toISOString(),
      });
    }

    if (round === 1 && askedEstimate) {
      script.say("carrier", rng.pick(["What am I clearing on that after fuel?", "What's fuel and tolls gonna run me on that?", "Hmm. What would I actually keep?"]));
      const trip = await estimateFor(p, load, counter);
      script.tool("get_trip_estimate", { loadId: load.loadId }, { status: trip ? "ok" : "estimate_unavailable" });
      script.say("agent", trip ? `At ${spoken(counter)}, you'd keep roughly ${spoken(Math.round(trip.carrierNetUsd / 10) * 10)} after about ${spoken(Math.round(trip.dieselUsd / 10) * 10)} in diesel${trip.tollShare !== null && trip.tollsUsd >= 20 ? ` and ${spoken(Math.round(trip.tollsUsd / 5) * 5)} in tolls` : ""}.` : "I can't work out the fuel and tolls on that load right now.");
    }

    if (outcome === "human" && round === 1) {
      script.say("carrier", rng.pick(["Can I just talk to a person?", "Let me talk to somebody on your team.", "I'd rather talk to a real dispatcher about this one."]));
      script.tool("request_human", {}, { status: "transferring" }, rng.pick(["Carrier wants to talk rate with a person", "Asked for a human", null]));
      script.say("agent", "Let me get a senior rep on the line; they will have everything we covered.");
      script.pause(rng.int(20, 90));
      human = true;
      break;
    }

    // The counter already carries any authorization; at the last round a carrier who wants the load takes it.
    const willTake = counter >= reservation || (outcome !== "lost" && round >= finalRound);
    const nextCounter = scheduledCounter(load.rate, load.maxBuy, round + 1);
    if (willTake) {
      script.say("carrier", rng.pick(["Yeah, I can do that.", "Alright, deal.", "Okay, let's book it.", "Fine, I'll take it."]));
      ask = counter;
    } else if (round > finalRound - 1) {
      script.say("carrier", rng.pick([`Can't do it under ${carrierMoney(rng, reservation)}.`, `Nah, I need ${carrierMoney(rng, reservation)}, diesel's killing me.`]));
      ask = reservation;
    } else {
      const previous = ask;
      ask = Math.max(reservation, Math.round((ask - (ask - nextCounter) * rng.between(0.2, 0.5)) / 25) * 25);
      script.say(
        "carrier",
        ask === previous
          ? rng.pick([`I still need ${carrierMoney(rng, ask)}.`, `Can't go under ${carrierMoney(rng, ask)} on that one.`])
          : rng.pick([`Meet me at ${carrierMoney(rng, ask)}?`, `How about ${carrierMoney(rng, ask)}?`, `Come up to ${carrierMoney(rng, ask)} and we're good.`]),
      );
    }
  }

  if (human) {
    return {};
  }
  if (agreed === null) {
    script.say("agent", "Want me to keep your truck on file and send you a load if one opens up near where you'll be empty?");
    script.say("carrier", rng.pick(["Nah, I'll find something.", "No, thanks though."]));
    script.say("agent", "No problem. Thanks for calling, drive safe.");
    return {};
  }
  return hold(p, load, agreed, outcome);
}

async function estimateFor(p: PlayInput, load: Load, rate: number): Promise<TripSnapshot | null> {
  const key = `${load.origin.zip}|${load.destination.zip}|${load.miles}|${rate}|${load.pickupAt.toISOString()}`;
  let pending = p.tripCache.get(key);
  if (!pending) {
    pending = p.input.estimate({ origin: load.origin, destination: load.destination, miles: load.miles, pickupAt: load.pickupAt, deliveryAt: load.deliveryAt, rate });
    p.tripCache.set(key, pending);
  }
  return pending;
}

async function hold(p: PlayInput, load: Load, agreed: number, outcome: Outcome): Promise<Played2> {
  const { rng, script } = p;
  const callId = script.callId;
  const trip = await estimateFor(p, load, agreed);
  // The desk ran human in the loop until two weeks ago, then let the agent book most loads itself.
  const autonomous = !load.live && p.input.now.getTime() - script.now.getTime() < 14 * 86_400_000 && rng.chance(0.55) && outcome !== "released";
  const response = { status: "ok", holdStatus: autonomous ? "booked" : "held" };
  script.tool("create_hold", { loadId: load.loadId, agreedRate: agreed }, response);
  const placedAt = script.now;
  script.say(
    "agent",
    autonomous
      ? `You're booked on that load at ${spoken(agreed)}. The rate confirmation is on its way.`
      : `That load is on hold for you at ${spoken(agreed)}. A senior rep will review it and get back to you shortly to confirm. You'll get an email as soon as a rep confirms it.`,
  );
  script.say("agent", "Anything else I can help you with?");
  script.say("carrier", rng.pick(["No, that's it. Thanks.", "Nope, appreciate it.", "That's all, thank you.", "All good, thanks man."]));
  script.say("agent", rng.pick(["Thanks for hauling with us. Drive safe.", "Appreciate you. Have a good one.", "Thanks, take care."]));

  // What happened after the call: a rep confirmed or released it; only the last few hours still wait.
  const pending = load.live;
  const decidedAt = new Date(placedAt.getTime() + rng.int(4, 45) * 60_000);
  const status = pending ? "held" : outcome === "released" ? "released" : "booked";
  const bookingRef = status === "booked" ? p.nextBooking() : null;
  const releaseReason = status === "released" ? rng.pick(["Shipper moved the pickup window", "Rate above what the customer approved", "Carrier failed the insurance check", "Load cancelled by shipper"]) : null;
  p.out.holds.push({
    call_id: callId,
    load_id: load.loadId,
    mc_number: p.carrier.mc,
    agreed_rate: agreed,
    status,
    booking_ref: bookingRef,
    release_reason: releaseReason,
    posted_rate: load.rate,
    max_buy: load.maxBuy,
    trip: trip ? JSON.stringify(trip) : null,
    created_at: placedAt.toISOString(),
    updated_at: (autonomous || pending ? placedAt : decidedAt).toISOString(),
  });
  if (!autonomous && !pending && p.input.noticeEmail !== null) {
    p.script.events.push({
      tool: "hold_notice",
      summary: `Load ${load.loadId} ${status === "booked" ? "confirmed" : "released"}: carrier notified by email`,
      status: "sent",
      at: decidedAt,
    });
  }
  return {};
}

// The carrier says where the truck frees up next and when; the newest trucks are fitted to the live board.
function saveCapacity(p: PlayInput, lane: LaneTemplate): Played2 {
  const { rng, script } = p;
  script.say("agent", "Want me to keep your truck on file and send you a load if one opens up near where you'll be empty?");
  script.say("carrier", rng.pick(["Yeah, that'd be great.", "Sure, go ahead.", "Yes please."]));
  const daysAgo = (p.input.now.getTime() - script.now.getTime()) / 86_400_000;
  const live = daysAgo < 2 ? p.liveFree.find((l) => l.equipment === lane.equipment) : undefined;
  if (live) p.liveFree.splice(p.liveFree.indexOf(live), 1);
  const freePlace = live ? live.origin : rng.chance(0.5) ? lane.origin : lane.destination;
  const freeDate = live ? new Date(live.pickupAt) : new Date(script.now.getTime() + rng.int(0, 2) * 86_400_000);
  const isoDay = (at: Date) => {
    const d = deskParts(at);
    return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  };
  script.say("agent", "Where does the truck free up?");
  script.say("carrier", `${freePlace.city}, ${freePlace.state}. I deliver there.`);
  script.say("agent", "And when?");
  script.say("carrier", rng.pick([`${spokenDate(freeDate)}.`, `Should be empty ${spokenDate(freeDate)}, morning.`]));
  const preferred = rng.chance(0.4) ? p.carrier.home.state : null;
  script.tool("save_capacity", { city: freePlace.city, state: freePlace.state }, { status: "ok" }, null);
  script.say("agent", "Got it, your truck is on file. If a load opens up near there we'll send you the details.");
  script.say("carrier", "Appreciate it.");
  script.say("agent", "Thanks for calling, drive safe.");

  // Older trucks: a rep notified about a third of them, and those carriers often call back.
  const notified = !live && daysAgo > 3 && rng.chance(0.35);
  const notifiedAt = notified ? new Date(script.now.getTime() + rng.int(3, 20) * 3_600_000) : null;
  const noticeLoad = notified ? makeLoad({ ...p, recent: false }, { ...lane, origin: freePlace }, null) : null;
  if (noticeLoad && notifiedAt) {
    noticeLoad.pickupAt = new Date(notifiedAt.getTime() + rng.int(20, 50) * 3_600_000);
    noticeLoad.deliveryAt = new Date(noticeLoad.pickupAt.getTime() + Math.ceil(noticeLoad.miles / 500) * 86_400_000);
  }
  p.out.capacity.push({
    call_id: script.callId,
    mc_number: p.carrier.mc,
    city: freePlace.city,
    state: freePlace.state,
    equipment: lane.equipment,
    free_date: isoDay(freeDate),
    preferred_destination_state: preferred,
    notified_load_id: noticeLoad?.loadId ?? null,
    notified_at: notifiedAt?.toISOString() ?? null,
    created_at: script.now.toISOString(),
  });
  return noticeLoad && notifiedAt ? { notice: { loadId: noticeLoad.loadId, at: notifiedAt, load: noticeLoad } } : {};
}
