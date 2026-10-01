import { NextResponse } from "next/server";
import { getCapacity } from "@/lib/adapter";

// Saved trucks and the open loads that fit them, for the dashboard. The browser polls every 60 s, so there is no server cache.
export async function GET() {
  const { httpStatus, body } = await getCapacity();
  return NextResponse.json(body, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
