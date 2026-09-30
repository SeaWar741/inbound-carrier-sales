import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { issueSession, safeEqual, sessionCookie, sessionTtlSeconds } from "@/lib/session";

const loginBody = z.object({ passcode: z.string().min(1).max(200) });

export async function POST(request: Request) {
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
