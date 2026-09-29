import { NextResponse } from "next/server";
import { getCarriers } from "@/lib/adapter";
import { toTowerCall, type TowerCarriers } from "@/lib/contracts";
import { liveRuns } from "@/lib/happyrobot";

// The inbox page of carriers. The browser's filters go to the adapter as they are; only the tower
// knows which calls are running, so it adds them as `live` and overlays each latest call like the wall.
export async function GET(request: Request) {
  const query = new URLSearchParams(new URL(request.url).search);
  const running = await liveRuns(query);

  const carriers = await getCarriers(query);
  if (!carriers.ok) {
    return NextResponse.json(carriers.body, { status: carriers.httpStatus, headers: { "cache-control": "no-store" } });
  }
  const body: TowerCarriers = {
    ...carriers.body,
    rows: carriers.body.rows.map((row) => ({ ...row, latestCall: toTowerCall(row.latestCall, running) })),
    liveUnavailable: running === undefined,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
