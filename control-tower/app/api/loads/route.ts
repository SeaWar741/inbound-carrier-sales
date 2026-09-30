import { NextResponse } from "next/server";
import { getLoads } from "@/lib/adapter";

// Booked loads for the dashboard map and list. The browser polls every 15 s, so there is no server cache.
export async function GET() {
  const { httpStatus, body } = await getLoads();
  return NextResponse.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
