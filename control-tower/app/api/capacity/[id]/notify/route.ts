import { NextResponse } from "next/server";
import { z } from "zod";
import { notifyCapacity } from "@/lib/adapter";
import { notifyCapacityBody } from "@/lib/contracts";

// Sends one open load to a saved truck's carrier. The adapter sends at most once per truck, so a repeated click is answered already_notified.

const params = z.object({ id: z.uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  const body = notifyCapacityBody.safeParse(await request.json().catch(() => null));
  if (!parsedParams.success || !body.success) {
    return NextResponse.json({ status: "invalid_request", message: "Send a truck id and a load id." }, { status: 400 });
  }
  const result = await notifyCapacity(parsedParams.data.id, body.data.loadId);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
