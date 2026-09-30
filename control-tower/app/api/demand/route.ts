import { NextResponse } from "next/server";
import { getDemand } from "@/lib/adapter";

// The demand page: its filters go to the adapter as they are.
export async function GET(request: Request) {
  const demand = await getDemand(new URLSearchParams(new URL(request.url).search));
  return NextResponse.json(demand.body, { status: demand.httpStatus, headers: { "cache-control": "no-store" } });
}
