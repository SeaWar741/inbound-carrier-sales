import { NextResponse } from "next/server";
import { getCarrierCalls } from "@/lib/adapter";

// One carrier's latest calls, newest first, as the adapter stores them (no live overlay).
// Next decodes the tagged key ("mc:123"); getCarrierCalls encodes it again for the adapter.
export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const { httpStatus, body } = await getCarrierCalls(key);
  return NextResponse.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
