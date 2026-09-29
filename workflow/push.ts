// Pushes a workflow definition to HappyRobot and publishes it to an environment.
// Usage: npm run push:workflow -- <name>   (inbound-carrier-sales | otp-email | otp-sms)
import { mkdir, writeFile } from "node:fs/promises";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import type { NodeInput } from "@happyrobot-ai/workflow-sdk";
import { z } from "zod";
import { buildAgent } from "./agent.ts";
import { buildOtpEmail, buildOtpSms } from "./otp-delivery.ts";

type WorkflowDefinition = {
  name: string;
  nodes: NodeInput[];
  exposedToolFields?: Record<string, string[]>;
  runDumpTable?: string;
};

const env = z
  .object({
    HAPPYROBOT_API_KEY: z.string().min(1),
    ADAPTER_URL: z.url().optional(),
    AGENT_API_KEY: z.string().min(16).optional(),
    TWILIO_CREDENTIAL_ID: z.string().min(1).optional(),
    TWILIO_PHONE_NUMBER: z.string().min(1).optional(),
  })
  .parse(process.env);

function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const value = env[key];
  if (value == null) throw new Error(`${key} is required for this workflow`);
  return value;
}

const definitions: Record<string, () => WorkflowDefinition> = {
  "inbound-carrier-sales": () =>
    buildAgent({ adapterUrl: requireEnv("ADAPTER_URL").replace(/\/$/, ""), agentApiKey: requireEnv("AGENT_API_KEY") }),
  "otp-email": buildOtpEmail,
  "otp-sms": () =>
    buildOtpSms({ twilioCredentialId: requireEnv("TWILIO_CREDENTIAL_ID"), twilioPhoneNumber: requireEnv("TWILIO_PHONE_NUMBER") }),
};

const environment = "development";
const client = new HappyRobotClient({ apiKey: env.HAPPYROBOT_API_KEY });

const workflowSchema = z.object({ id: z.string(), name: z.string(), latest_version: z.object({ id: z.string() }).nullish() });
const versionIdSchema = z.object({ id: z.string() });
async function findWorkflow(name: string) {
  for await (const item of client.workflows.listAll({})) {
    const workflow = workflowSchema.parse(item);
    if (workflow.name === name) return workflow;
  }
  return undefined;
}

const versionListSchema = z.object({
  data: z.array(z.object({ id: z.string(), is_published: z.boolean(), is_live: z.boolean(), environment: z.string() })),
});

// A published version is immutable: reuse the newest unpublished draft or fork a new one.
// Adding a batch that contains a trigger replaces the draft's nodes.
async function draftVersion(name: string): Promise<{ workflowId: string; versionId: string; liveVersionId?: string }> {
  const existing = await findWorkflow(name);
  if (!existing) {
    const created = workflowSchema.parse(await client.workflows.create({ name }));
    if (!created.latest_version) throw new Error(`Workflow ${name} was created without a version`);
    return { workflowId: created.id, versionId: created.latest_version.id };
  }
  const { data: versions } = versionListSchema.parse(await client.workflows.listVersions(existing.id, {}));
  const live = versions.find((v) => v.is_live && v.environment === environment);
  const [newest] = versions;
  if (!newest) throw new Error(`Workflow ${name} has no versions`);
  const versionId = newest.is_published ? versionIdSchema.parse(await client.versions.fork((live ?? newest).id)).id : newest.id;
  return { workflowId: existing.id, versionId, ...(live && { liveVersionId: live.id }) };
}

// Tool Call Result endpoints are not in the SDK yet. Generating fires each tool's webhook once,
// so the adapter must be reachable and every route must be safe to call with blank input.
const toolResultSchema = z.object({
  data: z.object({ nodes: z.array(z.object({ node_id: z.string(), fields: z.array(z.object({ path: z.string() })) })) }),
});

async function toolResultRequest(versionId: string, toolId: string, action: string, method: "POST" | "PUT", body: object) {
  const response = await fetch(`https://platform.happyrobot.ai/api/v2/versions/${versionId}/tools/${toolId}/tool-call-result/${action}`, {
    method,
    headers: { authorization: `Bearer ${env.HAPPYROBOT_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`tool-call-result/${action} failed with HTTP ${response.status}: ${await response.text()}`);
  return toolResultSchema.parse(await response.json());
}

const toolNodeSchema = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })) });

async function exposeToolFields(versionId: string, exposed: Record<string, string[]>) {
  const { data: nodes } = toolNodeSchema.parse(await client.nodes.list(versionId));
  for (const tool of nodes.filter((n) => n.type === "tool")) {
    const whitelist = exposed[tool.name];
    if (!whitelist) throw new Error(`No exposed fields declared for tool ${tool.name}`);
    const generated = await toolResultRequest(versionId, tool.id, "generate", "POST", { environment });
    for (const node of generated.data.nodes) {
      const available = new Set(node.fields.map((f) => f.path));
      const missing = whitelist.filter((path) => !available.has(path));
      if (missing.length > 0) throw new Error(`${tool.name} does not return ${missing.join(", ")}`);
      await toolResultRequest(versionId, tool.id, "visibility", "PUT", { node_id: node.node_id, exposed_fields: whitelist });
    }
    await toolResultRequest(versionId, tool.id, "inspect", "POST", {});
    console.log(`${tool.name}: exposes ${whitelist.join(", ")}`);
  }
}

const twinSchemaList = z.array(z.object({ name: z.string() }));

// Completed runs land in a Twin table; created once, the dump config follows new versions.
async function ensureRunDump(workflowId: string, tableName: string) {
  const headers = { authorization: `Bearer ${env.HAPPYROBOT_API_KEY}`, "content-type": "application/json" };
  const schema = twinSchemaList.parse(await (await fetch("https://platform.happyrobot.ai/api/v2/twin/schema", { headers })).json());
  if (schema.some((table) => table.name === tableName)) return;
  const response = await fetch("https://platform.happyrobot.ai/api/v2/twin/dump", {
    method: "POST",
    headers,
    body: JSON.stringify({ workflowId, tableName }),
  });
  if (!response.ok) throw new Error(`twin/dump failed with HTTP ${response.status}: ${await response.text()}`);
  console.log(`run dump table ${tableName} created`);
}

const name = process.argv[2] ?? "";
const build = definitions[name];
if (!build) throw new Error(`Unknown workflow "${name}". Known: ${Object.keys(definitions).join(", ")}`);

const definition = build();
const { workflowId, versionId, liveVersionId } = await draftVersion(definition.name);
await client.nodes.addBatch(versionId, { nodes: definition.nodes });
if (definition.exposedToolFields) await exposeToolFields(versionId, definition.exposedToolFields);
if (definition.runDumpTable) await ensureRunDump(workflowId, definition.runDumpTable);
await client.versions.publish(versionId, { environment, ...(liveVersionId && { unpublish_version_id: liveVersionId }) });

await mkdir(new URL("./.push-output/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`./.push-output/${definition.name}.json`, import.meta.url),
  `${JSON.stringify({ workflowId, versionId, environment, pushedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`${definition.name}: workflow ${workflowId}, version ${versionId}, published to ${environment}`);
