import { NextResponse } from "next/server";
import { z } from "zod";
import { releaseHold } from "@/lib/adapter";

// Frees a held load for other calls. No reason is sent, so the adapter stores its default.

const params = z.object({ id: z.uuid() });

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json({ status: "invalid_request", message: "Send a hold id." }, { status: 400 });
  }
  const result = await releaseHold(parsedParams.data.id, undefined);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
