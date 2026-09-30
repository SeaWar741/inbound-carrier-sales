import { NextResponse } from "next/server";
import { getCarrierCalls } from "@/lib/adapter";
import { toTowerCall, type TowerCarrierCalls } from "@/lib/contracts";
import { liveRuns } from "@/lib/happyrobot";

// One carrier's latest calls, newest first, and its list row, with the live HappyRobot session
// overlaid like the list. The browser sends the list's `since`; the tower adds the running calls
// as `live`. Next decodes the tagged key ("mc:123"); getCarrierCalls encodes it again for the adapter.
export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const query = new URLSearchParams();
  const since = new URL(request.url).searchParams.get("since");
  if (since) query.set("since", since);
  const running = await liveRuns(query);

  const carrierCalls = await getCarrierCalls(key, query);
  if (!carrierCalls.ok) {
    return NextResponse.json(carrierCalls.body, { status: carrierCalls.httpStatus, headers: { "cache-control": "no-store" } });
  }
  const { carrier } = carrierCalls.body;
  const body: TowerCarrierCalls = {
    ...carrierCalls.body,
    calls: carrierCalls.body.calls.map((call) => toTowerCall(call, running)),
    carrier: carrier && { ...carrier, latestCall: toTowerCall(carrier.latestCall, running) },
    liveUnavailable: running === undefined,
  };
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
