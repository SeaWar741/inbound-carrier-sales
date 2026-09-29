import { NextResponse } from "next/server";
import { z } from "zod";
import { releaseHold } from "@/lib/adapter";
import { releaseHoldBody } from "@/lib/contracts";

// Frees a held load for other calls. The body is optional; without a reason the adapter stores its default.

const params = z.object({ id: z.uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  const text = await request.text().catch(() => "");
  let raw: unknown = {};
  try {
    if (text.trim() !== "") raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const body = releaseHoldBody.safeParse(raw);
  if (!parsedParams.success || !body.success) {
    return NextResponse.json(
      { status: "invalid_request", message: "Send a hold id and, optionally, a reason of 1 to 200 characters." },
      { status: 400 },
    );
  }
  const result = await releaseHold(parsedParams.data.id, body.data.reason);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
