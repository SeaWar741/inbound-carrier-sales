// Runs simulated carrier conversations (HappyRobot e2e scenarios, text sessions) against the
// development live version of the agent. Scenarios are created once by name and updated when a
// persona changes.
// Usage: npm run simulate [-- <persona>...] [-- --wait]
//   (closer | haggler | walker | suspicious | ineligible | locked | human)
// Personas that search get a free load picked at run time: an OPEN load of the board snapshot
// that no Twin hold has taken (booked holds are never released, so those loads stay taken).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { z } from "zod";
import { finalRound, scheduledCounter } from "../src/domain/negotiation.ts";

const env = z.object({ HAPPYROBOT_API_KEY: z.string().min(1) }).parse(process.env);

const workflowName = "inbound-carrier-sales";
const environment = "development";
const agentNodeName = "carrier_sales_agent";
const triggerNodeName = "web_call";
const pollIntervalMs = 5_000;
const waitCapMs = 5 * 60_000;
// The platform default of 8 caller messages ends a call before the load is pitched; a full
// haggle (verification, search, three rounds, hold) takes about 20, and fillers like "Sure." count.
const maxAdversaryMessages = 30;

// The adapter pins the OTP to this code (OTP_FIXED_CODE) when it runs against the local fake TMS.
const fixedOtpCode = "424242";

// Eligible personas share MC 135797, whose name on file is J B Hunt Transport Inc.
const eligibleCarrier = `- Your MC number is 135797. Give it when asked.
- When the rep reads back your company name, accept "J B Hunt Transport Inc" or any close variant as correct.
- When asked how to receive a verification code, choose email.`;
const readsFixedCode = `- When asked for the code, read ${fixedOtpCode}.`;
// The pickup date filter would hide loads, so personas never name one.
const noPickupDate = "You have no pickup date in mind: if asked, say any day works and do not name a date.";

// A free load picked for one persona; the prompt names its origin and equipment only.
type PickedLoad = { loadId: string; city: string; state: string; equipment: string; rate: number; maxBuy: number };
const truck = (load: PickedLoad) =>
  `- You have a ${load.equipment.toLowerCase().replaceAll("_", " ")} empty in ${load.city}, ${load.state}, any destination. ${noPickupDate}`;
const equipmentLoad = (load: PickedLoad) => `${load.equipment.toLowerCase().replaceAll("_", " ")} load`;

// The counters the agent would say in rounds 1..finalRound for this load.
const counters = (load: PickedLoad) =>
  Array.from({ length: finalRound }, (_, i) => scheduledCounter(load.rate, load.maxBuy, i + 1));
// Every round concedes more than the one before, and the first is above the posted rate.
const hasAllRounds = (load: PickedLoad) =>
  counters(load).every((c, i, all) => c > (i === 0 ? load.rate : (all[i - 1] ?? load.rate)));

// Personas that search the board. `fits` says whether a load lets the persona reach its outcome
// with the asks its prompt makes: the first ask must draw a counter, the walker must never be
// accepted, and the haggler must still be above the next counter after each push.
const searchingPersonas = {
  closer: {
    fits: (load: PickedLoad) => counters(load)[0]! > load.rate,
    prompt: (load: PickedLoad) => `You are Sam, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
${eligibleCarrier}
${readsFixedCode}
${truck(load)}
- When a load is pitched, take the first ${equipmentLoad(load)}. When asked your rate, ask for about 20% above the loadboard rate.
- Accept the rep's first counter right away by saying the amount, for example "Deal, 2,200 dollars works."
- When the rep offers to hold the load, agree to the hold. Say goodbye only after the rep says a senior rep will confirm or the load is booked.
Keep every reply short, like a busy dispatcher on the phone.`,
  },
  haggler: {
    // Each ask (15% above the posted rate, then above each counter) stays above the next counter.
    fits: (load: PickedLoad) =>
      hasAllRounds(load) &&
      counters(load).every((c, i, all) => (i === 0 ? load.rate : (all[i - 1] ?? load.rate)) * 1.15 > c),
    prompt: (load: PickedLoad) => `You are Mike, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
${eligibleCarrier}
${readsFixedCode}
${truck(load)}
- When a load is pitched, take the first ${equipmentLoad(load)}. When asked your rate, ask for about 15% above the loadboard rate.
- Push back exactly twice: after the first and the second counter, ask for about 15% above that counter. The rep's
  third counter is final: accept it right away by saying the amount, for example "OK, I can do it for 3,400 dollars."
  Never ask for more after the third counter.
- If the rep says they cannot hold the load at that rate, repeat that you accept their last counter and say the amount again.
- When the rep offers to hold the load, agree to the hold. Say goodbye only after the rep says a senior rep will confirm or the load is booked.
Keep every reply short, like a busy dispatcher on the phone.`,
  },
  walker: {
    fits: (load: PickedLoad) => hasAllRounds(load) && load.rate * 1.35 > counters(load)[finalRound - 1]!,
    prompt: (load: PickedLoad) => `You are Rick, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
${eligibleCarrier}
${readsFixedCode}
${truck(load)}
- When a load is pitched, take the first ${equipmentLoad(load)}. When asked your rate, ask for about 35% above the loadboard rate.
- Reject every counter. After each one, say it is too low and ask again for about 35% above the loadboard rate. Never accept a counter and never lower your ask.
- When the rep says they cannot go higher or cannot do the load, say you will pass, thank them and say goodbye.
- Do not ask for a senior rep or a manager.
Keep every reply short, like a busy dispatcher on the phone.`,
  },
  human: {
    fits: (load: PickedLoad) => counters(load)[0]! > load.rate && load.rate * 1.2 > counters(load)[0]!,
    prompt: (load: PickedLoad) => `You are Dana, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
${eligibleCarrier}
${readsFixedCode}
${truck(load)}
- When a load is pitched, ask for about 20% above the loadboard rate.
- After the rep's first counter, say you want to talk to a real person, a senior rep, about this rate.
- After the rep answers that request, say you will wait for the rep, thank them and say goodbye.
Keep every reply short.`,
  },
} as const;
type SearchingPersona = keyof typeof searchingPersonas;

// Personas that never search keep a fixed prompt.
const fixedPersonas = {
  suspicious: `You are calling a freight broker to find a load, and something about your identity is off.
- Your MC number is 135797. Give it when asked.
- Insist your company is "Blue Ridge Freight Lines LLC" and your name is Tony Marsh, reachable at 555-013-2299.
- When the rep reads back a different company name, say that is not you, refuse to confirm it and repeat your company name.
- Never confirm the name on file, even if asked several times. Ask them to just send you loads anyway.
Keep every reply short.`,
  // FMCSA lists MC 1012 (DOT 2954368) as not allowed to operate, out of service since 2018-01-08.
  ineligible: `You are Luc, a dispatcher for 9339-6976 QUEBEC INC calling a freight broker to find a load.
- Your MC number is 1012. Give it when asked.
- If the rep reads back your company name, accept "9339-6976 Quebec Inc" as correct.
- You have a dry van empty in Baltimore, Maryland, any destination. ${noPickupDate}
- If the rep says you are not eligible, ask once why and whether they can make an exception. Then thank them and say goodbye.
Keep every reply short.`,
  locked: `You are Jo, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
${eligibleCarrier}
- You misread the email. When asked for the code, read 111111. If the rep says it is wrong, read 222222.
  If it is wrong again, read 333333. Never read any other code.
- Read all three codes, one per turn, even if the rep offers to resend the code before that. Do not stop early.
- Only after your third code, if the rep offers to send a new code, decline, thank them and say goodbye.
- You have a dry van empty in Detroit, Michigan, any destination. ${noPickupDate}
Keep every reply short.`,
} as const;

const personaNames = ["closer", "haggler", "walker", "suspicious", "ineligible", "locked", "human"] as const;
type PersonaName = (typeof personaNames)[number];
const isSearching = (persona: PersonaName): persona is SearchingPersona => persona in searchingPersonas;

const scenarioName = (persona: PersonaName) => `simulate-${persona}`;

const args = process.argv.slice(2);
const wait = args.includes("--wait");
const requested = args.filter((a) => a !== "--wait");
const unknown = requested.filter((a) => !(personaNames as readonly string[]).includes(a));
if (unknown.length > 0) throw new Error(`Unknown persona ${unknown.join(", ")}. Known: ${personaNames.join(", ")}`);
const selected = (requested.length > 0 ? requested : personaNames) as PersonaName[];

// Same snapshot the fake TMS serves (see test/fake-tms-server.ts).
const defaultSnapshotPath = fileURLToPath(new URL("../../docs/raw/tms-board-snapshot-2026-09-28.json", import.meta.url));
const boardRecordSchema = z.object({
  LOAD_ID: z.string(),
  ORIG_CITY: z.string(),
  ORIG_STATE: z.string(),
  EQTYPE: z.string(),
  RATE: z.string(),
  MAX_BUY: z.string(),
  STATUS: z.string(),
});

async function takenLoadIds(): Promise<Set<string>> {
  // A raw Twin call: search skips any load with a hold that was not released.
  const res = await fetch("https://platform.happyrobot.ai/api/v2/twin/sql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.HAPPYROBOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT load_id FROM holds WHERE status <> 'released'" }),
  });
  if (!res.ok) throw new Error(`Reading Twin holds failed: ${res.status}`);
  const body = z
    .object({ rows: z.array(z.object({ load_id: z.string() })), truncated: z.boolean() })
    .parse(await res.json());
  if (body.truncated) throw new Error("Reading Twin holds returned a truncated result");
  return new Set(body.rows.map((r) => r.load_id.trim().toUpperCase()));
}

// Gives each searching persona its own free load. Only loads alone in their origin city and
// equipment are used, so the search pitches exactly that load, and no two personas share a city.
async function pickLoads(personas: SearchingPersona[]): Promise<Map<SearchingPersona, PickedLoad>> {
  const picked = new Map<SearchingPersona, PickedLoad>();
  if (personas.length === 0) return picked;
  const snapshotPath = process.env.TMS_BOARD_SNAPSHOT ?? (existsSync(defaultSnapshotPath) ? defaultSnapshotPath : undefined);
  if (!snapshotPath) throw new Error(`TMS_BOARD_SNAPSHOT is required (no snapshot at ${defaultSnapshotPath})`);
  const taken = await takenLoadIds();
  const free: PickedLoad[] = z
    .array(boardRecordSchema)
    .parse(JSON.parse(readFileSync(snapshotPath, "utf8")))
    .filter((r) => r.STATUS.trim() === "OPEN" && !taken.has(r.LOAD_ID.trim().toUpperCase()))
    .map((r) => ({
      loadId: r.LOAD_ID.trim(),
      city: r.ORIG_CITY.trim(),
      state: r.ORIG_STATE.trim(),
      equipment: r.EQTYPE.trim(),
      rate: Number(r.RATE.trim()),
      maxBuy: Number(r.MAX_BUY.trim()),
    }))
    .sort((a, b) => a.loadId.localeCompare(b.loadId));
  const lane = (l: PickedLoad) => `${l.city}|${l.state}|${l.equipment}`.toUpperCase();
  const city = (l: PickedLoad) => `${l.city}|${l.state}`.toUpperCase();
  const alone = free.filter((l) => free.filter((o) => lane(o) === lane(l)).length === 1);
  const usedCities = new Set<string>();
  // The pickiest personas choose first so the easy ones do not use up their loads.
  const order = [...personas].sort((a, b) => alone.filter(searchingPersonas[a].fits).length - alone.filter(searchingPersonas[b].fits).length);
  for (const persona of order) {
    const load = alone.find((l) => !usedCities.has(city(l)) && searchingPersonas[persona].fits(l));
    if (!load) {
      throw new Error(
        `No free load left for ${persona} (${taken.size} loads are held or booked in Twin). ` +
          "Restart npm run fake:tms and run fewer personas, or use a fresh TMS_BOARD_SNAPSHOT.",
      );
    }
    usedCities.add(city(load));
    picked.set(persona, load);
  }
  return picked;
}

const picks = await pickLoads(selected.filter(isSearching));
for (const [persona, load] of picks) {
  console.log(
    `${persona}: ${load.loadId} ${load.equipment} ${load.city}, ${load.state}  rate ${load.rate}  max buy ${load.maxBuy}  counters ${counters(load).join("/")}`,
  );
}
const promptFor = (persona: PersonaName): string => {
  if (!isSearching(persona)) return fixedPersonas[persona];
  const load = picks.get(persona);
  if (!load) throw new Error(`No load picked for ${persona}`);
  return searchingPersonas[persona].prompt(load);
};

const client = new HappyRobotClient({ apiKey: env.HAPPYROBOT_API_KEY });

const workflowSchema = z.object({ id: z.string(), name: z.string() });
async function findWorkflowId(name: string) {
  for await (const item of client.workflows.listAll({})) {
    const workflow = workflowSchema.parse(item);
    if (workflow.name === name) return workflow.id;
  }
  throw new Error(`Workflow ${name} not found`);
}

const versionListSchema = z.object({
  data: z.array(z.object({ id: z.string(), is_live: z.boolean(), environment: z.string() })),
});
const nodeListSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), persistent_id: z.string() })),
});

const workflowId = await findWorkflowId(workflowName);
const { data: versions } = versionListSchema.parse(await client.workflows.listVersions(workflowId, {}));
const live = versions.find((v) => v.is_live && v.environment === environment);
if (!live) throw new Error(`${workflowName} has no live ${environment} version`);
const { data: nodes } = nodeListSchema.parse(await client.nodes.list(live.id));
const persistentId = (name: string) => {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`Node ${name} not found in version ${live.id}`);
  return node.persistent_id;
};
const agentPersistentId = persistentId(agentNodeName);
const triggerPersistentId = persistentId(triggerNodeName);

// Scenario runs refuse a version whose prompt has no enabled Northstars, and every push makes new
// nodes without any. The SDK has no list or generate for them, so these are raw calls.
const northstarsUrl = (nodeId: string) => `https://platform.happyrobot.ai/api/v2/nodes/${nodeId}/northstars`;
const northstarListSchema = z.object({ data: z.array(z.object({ enabled: z.boolean() })) });
async function enabledNorthstars(nodeId: string) {
  const res = await fetch(northstarsUrl(nodeId), { headers: { authorization: `Bearer ${env.HAPPYROBOT_API_KEY}` } });
  if (!res.ok) throw new Error(`Listing northstars failed: ${res.status}`);
  return northstarListSchema.parse(await res.json()).data.filter((n) => n.enabled).length;
}
const promptNode = nodes.find((n) => n.type === "prompt");
if (!promptNode) throw new Error(`No prompt node in version ${live.id}`);
if ((await enabledNorthstars(promptNode.id)) === 0) {
  console.log("Generating Northstars for the new version (takes about a minute)");
  const res = await fetch(`${northstarsUrl(promptNode.id)}/generate`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.HAPPYROBOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ version_id: live.id }),
  });
  if (!res.ok) throw new Error(`Generating northstars failed: ${res.status}`);
  for (let i = 0; (await enabledNorthstars(promptNode.id)) === 0; i++) {
    if (i >= 30) throw new Error("Northstars were not generated within 5 minutes");
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

const existing = (await client.e2eScenarios.list(workflowId)).scenarios;

async function ensureScenario(persona: PersonaName) {
  const name = scenarioName(persona);
  const prompt = promptFor(persona);
  const found = existing.find((s) => s.name === name && !s.is_deleted);
  if (found) {
    // Every push replaces the nodes, so the target agent and trigger are refreshed too.
    if (
      found.adversarial_prompt !== prompt ||
      found.target_agent_node_persistent_id !== agentPersistentId ||
      found.max_adversary_messages !== maxAdversaryMessages
    ) {
      await client.e2eScenarios.update(found.id, {
        adversarialPrompt: prompt,
        maxAdversaryMessages,
        targetAgentNodePersistentId: agentPersistentId,
        seeds: [{ persistent_id: triggerPersistentId, kind: "trigger", input: {} }],
      });
    }
    return found.id;
  }
  const { scenario } = await client.e2eScenarios.create({
    targetUseCaseId: workflowId,
    targetAgentNodePersistentId: agentPersistentId,
    mode: "whole_run",
    seeds: [{ persistent_id: triggerPersistentId, kind: "trigger", input: {} }],
    targetEnvironment: environment,
    name,
    adversarialPrompt: prompt,
    maxAdversaryMessages,
  });
  return scenario.id;
}

type Started = { persona: PersonaName; scenarioId: string; scenarioRunId: string };

const started: Started[] = await Promise.all(
  selected.map(async (persona) => {
    const scenarioId = await ensureScenario(persona);
    const { scenarioRunId } = await client.e2eScenarios.run(scenarioId, live.id);
    return { persona, scenarioId, scenarioRunId };
  }),
);

async function runState({ scenarioId, scenarioRunId }: Started) {
  const { runs } = await client.e2eScenarios.runs(scenarioId, 20);
  return runs.find((r) => r.id === scenarioRunId);
}

const finished = new Set(["completed", "failed", "error", "cancelled", "canceled", "timed_out", "timeout"]);
const describe = (s: Started, run: Awaited<ReturnType<typeof runState>>) =>
  `${scenarioName(s.persona)}  run ${run?.target_run_id ?? "(pending)"}  ${run?.status ?? "unknown"}${
    run?.target_run_status ? ` / ${run.target_run_status}` : ""
  }  ${run?.result_state ?? ""}${run?.error_message ? `  ${run.error_message}` : ""}`;

if (wait) {
  const deadline = Date.now() + waitCapMs;
  const pending = new Set(started);
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    for (const s of [...pending]) {
      const run = await runState(s);
      if (run && finished.has(run.status)) {
        console.log(describe(s, run));
        pending.delete(s);
      }
    }
  }
  for (const s of pending) console.log(`${describe(s, await runState(s))}  (still running after 5 minutes)`);
} else {
  // Give the platform a moment to create the target run so its id can be printed.
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  for (const s of started) console.log(describe(s, await runState(s)));
}
