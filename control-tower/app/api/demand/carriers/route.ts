import { NextResponse } from "next/server";
import { getDemandCarriers } from "@/lib/adapter";

// The carriers behind one demand row: the row's lane and the page go to the adapter as they are.
export async function GET(request: Request) {
  const carriers = await getDemandCarriers(new URLSearchParams(new URL(request.url).search));
  return NextResponse.json(carriers.body, { status: carriers.httpStatus, headers: { "cache-control": "no-store" } });
}
