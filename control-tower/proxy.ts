import { NextResponse, type NextRequest } from "next/server";
import { clientOf, fixedWindow } from "./lib/rate-limit";
import { isValidSession, sessionCookie } from "./lib/session";

// Only the login page and its route are public; every other page and API route needs the operator session.
const publicPaths = new Set(["/login", "/api/login"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

// Per client and minute. Reads cover several open tabs polling (the wall alone is 30 a minute);
// writes are clicks, and each can reach a carrier or the live agent.
const reads = fixedWindow(600, 60_000);
const writes = fixedWindow(60, 60_000);

const tooMany = () => NextResponse.json({ status: "too_many_requests" }, { status: 429, headers: { "retry-after": "60" } });

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isWrite = !safeMethods.has(request.method);

  // SameSite=strict already keeps the cookie off cross-site requests; a foreign Origin on a write is refused anyway.
  const origin = request.headers.get("origin");
  if (isWrite && origin !== null && URL.canParse(origin) && new URL(origin).host !== request.headers.get("host")) {
    return NextResponse.json({ status: "forbidden" }, { status: 403 });
  }
  if (isApi && (isWrite ? writes : reads).take(clientOf(request.headers))) return tooMany();

  if (publicPaths.has(pathname)) return NextResponse.next();
  const secret = process.env.SESSION_SECRET;
  if (secret && isValidSession(secret, request.cookies.get(sessionCookie)?.value)) return NextResponse.next();
  if (isApi) return NextResponse.json({ status: "unauthorized" }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
