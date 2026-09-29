import { NextResponse } from "next/server";
import { setAutonomy } from "@/lib/adapter";
import { setAutonomyBody } from "@/lib/contracts";

// Switches every new call between "human" (a rep confirms each hold) and "autonomous" (the agent books).
export async function PUT(request: Request) {
  const body = setAutonomyBody.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ status: "invalid_request", message: 'Send {"mode": "human" | "autonomous"}.' }, { status: 400 });
  }
  const result = await setAutonomy(body.data.mode);
  return NextResponse.json(result.ok ? { status: "ok", mode: result.body.mode } : result.body, { status: result.httpStatus });
}
