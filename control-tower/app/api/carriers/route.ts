import { NextResponse } from "next/server";
import { getCarriers } from "@/lib/adapter";
import { toTowerCall, type TowerCarriers } from "@/lib/contracts";
import { listRunningRuns } from "@/lib/happyrobot";

// The adapter caps the running call ids it accepts.
const maxLive = 200;

// The inbox page of carriers. The browser's filters go to the adapter as they are; only the tower
// knows which calls are running, so it adds them as `live` and overlays each latest call like the wall.
export async function GET(request: Request) {
  const runs = await listRunningRuns().catch(() => undefined);
  const query = new URLSearchParams(new URL(request.url).search);
  query.delete("live");
  for (const run of runs?.slice(0, maxLive) ?? []) query.append("live", run.runId);

  const carriers = await getCarriers(query);
  if (!carriers.ok) {
    return NextResponse.json(carriers.body, { status: carriers.httpStatus, headers: { "cache-control": "no-store" } });
  }
  const running = runs && new Map(runs.map((run) => [run.runId, run]));
  const body: TowerCarriers = {
    ...carriers.body,
    rows: carriers.body.rows.map((row) => ({ ...row, latestCall: toTowerCall(row.latestCall, running) })),
    liveUnavailable: runs === undefined,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
