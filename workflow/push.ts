// Pushes a workflow definition to HappyRobot and publishes it to an environment.
// Usage: npm run push:workflow -- <name>   (otp-email | otp-sms)
import { mkdir, writeFile } from "node:fs/promises";
import { HappyRobotClient } from "@happyrobot-ai/sdk";
import type { NodeInput } from "@happyrobot-ai/workflow-sdk";
import { z } from "zod";
import { buildOtpEmail, buildOtpSms } from "./otp-delivery.ts";

type WorkflowDefinition = { name: string; nodes: NodeInput[] };

const env = z
  .object({
    HAPPYROBOT_API_KEY: z.string().min(1),
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

const name = process.argv[2] ?? "";
const build = definitions[name];
if (!build) throw new Error(`Unknown workflow "${name}". Known: ${Object.keys(definitions).join(", ")}`);

const definition = build();
const { workflowId, versionId, liveVersionId } = await draftVersion(definition.name);
await client.nodes.addBatch(versionId, { nodes: definition.nodes });
await client.versions.publish(versionId, { environment, ...(liveVersionId && { unpublish_version_id: liveVersionId }) });

await mkdir(new URL("./.push-output/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`./.push-output/${definition.name}.json`, import.meta.url),
  `${JSON.stringify({ workflowId, versionId, environment, pushedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(`${definition.name}: workflow ${workflowId}, version ${versionId}, published to ${environment}`);
