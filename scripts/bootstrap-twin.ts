// Creates the Twin tables (idempotent) and measures SQL round-trip latency.
// Usage: npm run bootstrap:twin
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TwinClient, sql } from "../src/infra/twin-client.ts";
import { callRowSchema, migrations, tableDdl, type TableName } from "../src/infra/twin-schemas.ts";

const env = z.object({ HAPPYROBOT_API_KEY: z.string().min(1) }).parse(process.env);
const twin = new TwinClient({ apiKey: env.HAPPYROBOT_API_KEY });

const existsRow = z.object({ exists: z.boolean() });

for (const [name, ddl] of Object.entries(tableDdl) as [TableName, string][]) {
  const [before] = await twin.query(sql`SELECT to_regclass(${name}) IS NOT NULL AS exists`, existsRow);
  await twin.query({ text: ddl }, z.unknown());
  console.log(`${name}: ${before?.exists ? "skipped (exists)" : "created"}`);
}

for (const statement of migrations) await twin.query({ text: statement }, z.unknown());
console.log(`migrations: ${migrations.length} applied`);

// One OTP-style write followed by the read that would verify it: the hot path of a call.
const samples: number[] = [];
const probeIds: string[] = [];
for (let i = 0; i < 20; i++) {
  const callId = `latency-probe-${randomUUID()}`;
  probeIds.push(callId);
  const started = performance.now();
  await twin.query(sql`INSERT INTO calls (call_id) VALUES (${callId}) RETURNING call_id`, z.unknown());
  await twin.query(sql`SELECT * FROM calls WHERE call_id = ${callId}`, callRowSchema);
  samples.push(performance.now() - started);
}
await twin.query(sql`DELETE FROM calls WHERE call_id LIKE ${"latency-probe-%"} RETURNING call_id`, z.unknown());

const sorted = samples.toSorted((a, b) => a - b);
const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
console.log(
  `insert+read round trip over ${samples.length} samples: p50 ${percentile(50).toFixed(0)} ms, p95 ${percentile(95).toFixed(0)} ms, max ${sorted.at(-1)?.toFixed(0)} ms`,
);
