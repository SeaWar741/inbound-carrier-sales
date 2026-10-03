import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { clientOf, counter } from "@/lib/rate-limit";
import { issueSession, safeEqual, sessionCookie, sessionTtlSeconds } from "@/lib/session";

const loginBody = z.object({ passcode: z.string().min(1).max(200) });

// Passcode attempts over 15 minutes, counted across every tower instance: 10 per client, 30 in total.
// The total cap stops a guesser that rotates addresses; at worst it locks the desk out for one window.
// Each attempt waits for the shared count: logins are rare, and this guards the passcode.
const loginWindowMs = 15 * 60 * 1000;
const perClient = 10;
const total = 30;

export async function POST(request: Request) {
  const client = clientOf(request.headers);
  const [clientAttempts, allAttempts] = await Promise.all([
    counter.takeExact(`login:${client}`, perClient, loginWindowMs),
    counter.takeExact("login:all", total, loginWindowMs),
  ]);
  if (clientAttempts > perClient || allAttempts > total) {
    return NextResponse.json({ status: "too_many_requests" }, { status: 429, headers: { "retry-after": "900" } });
  }
  const body = loginBody.safeParse(await request.json().catch(() => null));
  const { OPERATOR_PASSCODE, SESSION_SECRET } = env();
  if (!body.success || !safeEqual(body.data.passcode, OPERATOR_PASSCODE)) {
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
