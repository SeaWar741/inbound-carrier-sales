import { hitRateLimit } from "./adapter";
import { SharedCounter } from "./shared-counter";

// Every tower instance counts together: hits go to Twin through the adapter (see SharedCounter).
export const counter = new SharedCounter(hitRateLimit);

// The client address as Render reports it. A forged X-Forwarded-For only buys a fresh per-client
// window, so every limit that guards a secret has a total cap as well.
export const clientOf = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
