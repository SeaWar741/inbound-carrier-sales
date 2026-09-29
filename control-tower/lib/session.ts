import { createHmac, timingSafeEqual } from "node:crypto";

// The session cookie is "<expiresAtMs>.<hmac>": nothing secret inside, only proof the
// server issued it and when it stops being valid.
export const sessionCookie = "tower_session";
export const sessionTtlSeconds = 12 * 60 * 60;

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueSession(secret: string, now = Date.now()): string {
  const expiresAt = String(now + sessionTtlSeconds * 1000);
  return `${expiresAt}.${sign(secret, expiresAt)}`;
}

export function isValidSession(secret: string, token: string | undefined, now = Date.now()): boolean {
  const [expiresAt, mac, ...rest] = token?.split(".") ?? [];
  if (!expiresAt || !mac || rest.length > 0 || !/^\d+$/.test(expiresAt)) return false;
  if (!safeEqual(mac, sign(secret, expiresAt))) return false;
  return Number(expiresAt) > now;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
