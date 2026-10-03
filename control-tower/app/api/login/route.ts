import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { clientOf, fixedWindow } from "@/lib/rate-limit";
import { issueSession, safeEqual, sessionCookie, sessionTtlSeconds } from "@/lib/session";

const loginBody = z.object({ passcode: z.string().min(1).max(200) });

// Failed passcodes over 15 minutes: 5 per client, 30 in total. The total cap stops a guesser that rotates
// addresses; at worst it locks the desk out for one window.
const failuresPerClient = fixedWindow("login-client", 5, 15 * 60 * 1000);
const failuresTotal = fixedWindow("login-total", 30, 15 * 60 * 1000);

export async function POST(request: Request) {
  const client = clientOf(request.headers);
  if ((await failuresPerClient.blocked(client)) || (await failuresTotal.blocked("all"))) {
    return NextResponse.json({ status: "too_many_requests" }, { status: 429, headers: { "retry-after": "900" } });
  }
  const body = loginBody.safeParse(await request.json().catch(() => null));
  const { OPERATOR_PASSCODE, SESSION_SECRET } = env();
  if (!body.success || !safeEqual(body.data.passcode, OPERATOR_PASSCODE)) {
    await Promise.all([failuresPerClient.record(client), failuresTotal.record("all")]);
    return NextResponse.json({ status: "invalid_passcode" }, { status: 401 });
  }
  const response = NextResponse.json({ status: "ok" });
  response.cookies.set(sessionCookie, issueSession(SESSION_SECRET), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: sessionTtlSeconds,
  });
  return response;
}
