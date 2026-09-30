import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, sessionCookie } from "./lib/session";

// Every page and API route needs the operator session, except the login page and its route.
export function proxy(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  if (secret && isValidSession(secret, request.cookies.get(sessionCookie)?.value)) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!login|api/login|_next/static|_next/image|favicon.ico).*)"],
};
