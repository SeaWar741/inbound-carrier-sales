import { NextResponse } from "next/server";
import { z } from "zod";
import { recordIntervention } from "@/lib/adapter";
import { callIdInput, voiceTokenBody, type VoiceTokenResponse } from "@/lib/contracts";
import { createVoiceToken, sessionForRun } from "@/lib/happyrobot";

// A LiveKit token to listen to or take over a live call. The route id is the call id (HappyRobot run id).

const params = z.object({ id: callIdInput });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const parsedParams = params.safeParse(await context.params);
  const body = voiceTokenBody.safeParse(await request.json().catch(() => null));
  if (!parsedParams.success || !body.success) {
    return NextResponse.json(
      { status: "invalid_request", message: "Send mode listen or takeover." },
      { status: 400 },
    );
  }
  const callId = parsedParams.data.id;
  const { mode } = body.data;

  let sessionId: string | null;
  try {
    sessionId = await sessionForRun(callId);
  } catch {
    return NextResponse.json(
      { status: "live_unavailable", message: "Could not reach HappyRobot to find the call's session." },
      { status: 502 },
    );
  }
  if (sessionId === null) {
    return NextResponse.json({ status: "not_found", message: "No session for this call." }, { status: 404 });
  }

  let token: VoiceTokenResponse;
  try {
    token = await createVoiceToken(sessionId, mode === "takeover");
  } catch {
    return NextResponse.json(
      { status: "live_unavailable", message: "Could not join the call. It may have ended." },
      { status: 502 },
    );
  }

  // The token is what matters to the operator; a failed audit record is logged, not surfaced as a failure.
  const recorded = await recordIntervention(callId, { kind: mode });
  if (!recorded.ok) console.warn(`voice-token: ${mode} intervention not recorded (${recorded.httpStatus})`);

  return NextResponse.json(token, { headers: { "cache-control": "no-store" } });
}
