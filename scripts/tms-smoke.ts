// Read-only check against the real TMS: DEBUG_ECHO, one LOAD_QUERY, one LOAD_GET.
// Never books. Usage: npm run smoke:tms
import { z } from "zod";
import { TmsClient } from "../src/infra/tms/tms-client.ts";

const env = z
  .object({ TMS_HOST: z.string().min(1), TMS_PORT: z.coerce.number().int().positive(), TMS_TOKEN: z.string().min(1) })
  .parse(process.env);

const tms = new TmsClient({
  host: env.TMS_HOST,
  port: env.TMS_PORT,
  token: env.TMS_TOKEN,
  onExchange: (e) => console.log(`  [${e.command} #${e.attempt}] ${e.outcome}${e.code ? ` ${e.code}` : ""} ${e.latencyMs} ms`),
});

console.log("DEBUG_ECHO", await tms.debugEcho("smoke"));

const loads = await tms.queryLoads({ equipmentType: "flatbed", maxResults: 3 });
console.log(`LOAD_QUERY EQTYPE=FLATBED -> ${loads.length} load(s)`);
console.table(loads);

const loadId = loads[0]?.loadId ?? "LD00881";
console.log(`LOAD_GET ${loadId}`, await tms.getLoad(loadId));
