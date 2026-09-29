import { NextResponse } from "next/server";
import { getCarrierCalls } from "@/lib/adapter";
import { toTowerCall, type TowerCarrierCalls } from "@/lib/contracts";
import { listRunningRuns } from "@/lib/happyrobot";

// One carrier's latest calls, newest first, with the live HappyRobot session overlaid like the wall.
// Next decodes the tagged key ("mc:123"); getCarrierCalls encodes it again for the adapter.
export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const [runs, carrierCalls] = await Promise.all([listRunningRuns().catch(() => undefined), getCarrierCalls(key)]);
  if (!carrierCalls.ok) {
    return NextResponse.json(carrierCalls.body, { status: carrierCalls.httpStatus, headers: { "cache-control": "no-store" } });
  }
  const running = runs && new Map(runs.map((run) => [run.runId, run]));
  const body: TowerCarrierCalls = {
    ...carrierCalls.body,
    calls: carrierCalls.body.calls.map((call) => toTowerCall(call, running)),
    liveUnavailable: runs === undefined,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
