import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmHold } from "@/lib/adapter";
import { idempotencyKeyInput } from "@/lib/contracts";

// Books a held load. The browser makes one Idempotency-Key per click, so a retried request never books twice.

const params = z.object({ id: z.uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  const key = idempotencyKeyInput.safeParse(request.headers.get("idempotency-key"));
  if (!parsedParams.success || !key.success) {
    return NextResponse.json(
      { status: "invalid_request", message: "Send a hold id and an Idempotency-Key header of 1 to 128 characters." },
      { status: 400 },
    );
  }
  const result = await confirmHold(parsedParams.data.id, key.data);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
