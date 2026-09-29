import { NextResponse } from "next/server";
import { z } from "zod";
import { recordIntervention, type InterventionRecord } from "@/lib/adapter";
import { callIdInput, interventionBody, type InterventionResponse } from "@/lib/contracts";
import { publishSignal } from "@/lib/happyrobot";

// A whisper or an authorization for a live call. The adapter records it first, so an authorization is
// already in place when the agent's next evaluate_offer runs; only then is the signal sent to the agent.

const params = z.object({ id: callIdInput });

const authorizationInstruction = (amountUsd: number, loadId: string) =>
  `A senior rep authorized up to $${amountUsd} more on load ${loadId}. Price through evaluate_offer as usual.`;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  const body = interventionBody.safeParse(await request.json().catch(() => null));
  if (!parsedParams.success || !body.success) {
    return NextResponse.json(
      { status: "invalid_request", message: "Send a whisper with a message, or an authorization with a load id and an amount." },
      { status: 400 },
    );
  }
  const intervention = body.data;

  const record: InterventionRecord =
    intervention.kind === "authorization"
      ? {
          kind: "authorization",
          loadId: intervention.loadId,
          amountUsd: intervention.amountUsd,
          ...(intervention.message ? { message: intervention.message } : {}),
        }
      : { kind: "whisper", message: intervention.message };
  const recorded = await recordIntervention(parsedParams.data.id, record);
  if (!recorded.ok) return NextResponse.json(recorded.body, { status: recorded.httpStatus });

  const instruction =
    intervention.kind === "authorization" && !intervention.message
      ? authorizationInstruction(intervention.amountUsd, intervention.loadId)
      : intervention.message;
  const sent = await publishSignal(intervention.sessionId, instruction);
  const answer: InterventionResponse = { status: sent ? "sent" : "recorded_not_sent" };
  return NextResponse.json(answer);
}
