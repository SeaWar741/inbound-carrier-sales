import { NextResponse } from "next/server";
import { getNetwork } from "@/lib/adapter";

// The carriers page: its view and filters go to the adapter as they are.
export async function GET(request: Request) {
  const network = await getNetwork(new URLSearchParams(new URL(request.url).search));
  return NextResponse.json(network.body, { status: network.httpStatus, headers: { "cache-control": "no-store" } });
}
