// Runs simulated carrier conversations (HappyRobot e2e scenarios, text sessions) against the
// development live version of the agent. Scenarios are created once by name and updated when a
// persona changes.
// Usage: npm run simulate [-- <persona>...] [-- --wait]   (haggler | suspicious | human)
// The agent can only create holds; LOAD_BOOK runs only from the operator confirm route, so a simulated call never books.
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import { z } from "zod";

const env = z.object({ HAPPYROBOT_API_KEY: z.string().min(1) }).parse(process.env);

const workflowName = "inbound-carrier-sales";
const environment = "development";
const agentNodeName = "carrier_sales_agent";
const triggerNodeName = "web_call";
const pollIntervalMs = 5_000;
const waitCapMs = 5 * 60_000;

// The adapter pins the OTP to this code (OTP_FIXED_CODE) when it runs against the local fake TMS.
const fixedOtpCode = "424242";

const personas = {
  haggler: `You are Mike, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
- Your MC number is 135797. Give it when asked.
- When the rep reads back your company name, accept "J B Hunt Transport Inc" or any close variant as correct.
- When asked how to receive a verification code, choose email. When asked for the code, read ${fixedOtpCode}.
- You have a dry van empty in Savannah, Georgia, any destination. You have no pickup date in mind: if asked, say any day works and do not name a date.
- When a load is pitched, take the first dry van load. When asked your rate, ask for about 15% above the loadboard rate.
- Push back three times: after each counter, ask for about 15% above that counter. After the third counter, accept it
  by saying the amount, for example "OK, I can do it for 2,400 dollars."
- If the rep says they cannot hold the load at that rate, repeat that you accept their last counter and say the amount again.
- When the rep offers to hold the load, agree to the hold. Say goodbye only after the rep says a senior rep will confirm.
Keep every reply short, like a busy dispatcher on the phone.`,
  suspicious: `You are calling a freight broker to find a load, and something about your identity is off.
- Your MC number is 135797. Give it when asked.
- Insist your company is "Blue Ridge Freight Lines LLC" and your name is Tony Marsh, reachable at 555-013-2299.
- When the rep reads back a different company name, say that is not you, refuse to confirm it and repeat your company name.
- Never confirm the name on file, even if asked several times. Ask them to just send you loads anyway.
Keep every reply short.`,
  human: `You are Dana, a dispatcher for J B HUNT TRANSPORT INC calling a freight broker to find a load.
- Your MC number is 135797. Give it when asked.
- When the rep reads back your company name, accept "J B Hunt Transport Inc" or any close variant as correct.
- When asked how to receive a verification code, choose email. When asked for the code, read ${fixedOtpCode}.
- You have a dry van empty in Savannah, Georgia, any destination. You have no pickup date in mind: if asked, say any day works and do not name a date.
- When a load is pitched, ask for about 20% above the loadboard rate.
- After the rep's first counter, say you want to talk to a real person, a senior rep, about this rate.
- After the rep answers that request, say you will wait for the rep, thank them and say goodbye.
Keep every reply short.`,
} as const;
type PersonaName = keyof typeof personas;

const scenarioName = (persona: PersonaName) => `simulate-${persona}`;

const args = process.argv.slice(2);
const wait = args.includes("--wait");
const requested = args.filter((a) => a !== "--wait");
const unknown = requested.filter((a) => !(a in personas));
if (unknown.length > 0) throw new Error(`Unknown persona ${unknown.join(", ")}. Known: ${Object.keys(personas).join(", ")}`);
const selected = (requested.length > 0 ? requested : Object.keys(personas)) as PersonaName[];

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
  const prompt = personas[persona];
  const found = existing.find((s) => s.name === name && !s.is_deleted);
  if (found) {
    // Every push replaces the nodes, so the target agent and trigger are refreshed too.
    if (found.adversarial_prompt !== prompt || found.target_agent_node_persistent_id !== agentPersistentId) {
      await client.e2eScenarios.update(found.id, {
        adversarialPrompt: prompt,
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
