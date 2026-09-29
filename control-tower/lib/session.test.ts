import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { issueSession, isValidSession, sessionTtlSeconds } from "./session.ts";

const secret = "s".repeat(32);
const now = 1_790_000_000_000;

describe("isValidSession", () => {
  it("accepts a token it issued before it expires", () => {
    assert.equal(isValidSession(secret, issueSession(secret, now), now + 1_000), true);
  });

  it("rejects a tampered MAC", () => {
    const [expiresAt, mac] = issueSession(secret, now).split(".") as [string, string];
    const flipped = `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
    assert.equal(isValidSession(secret, `${expiresAt}.${flipped}`, now), false);
  });

  it("rejects an expired token", () => {
    const token = issueSession(secret, now);
    assert.equal(isValidSession(secret, token, now + sessionTtlSeconds * 1000), false);
  });

  it("rejects a token with an extra segment", () => {
    assert.equal(isValidSession(secret, `${issueSession(secret, now)}.extra`, now), false);
  });

  it("rejects a non-numeric expiry even when it is signed", () => {
    for (const expiresAt of ["Infinity", `${now + 1e6}x`, "1e20"]) {
      const mac = createHmac("sha256", secret).update(expiresAt).digest("base64url");
      assert.equal(isValidSession(secret, `${expiresAt}.${mac}`, now), false);
    }
  });

  it("rejects a token signed with another secret", () => {
    assert.equal(isValidSession(secret, issueSession("o".repeat(32), now), now), false);
  });

  it("rejects a missing token", () => {
    assert.equal(isValidSession(secret, undefined, now), false);
  });
});
