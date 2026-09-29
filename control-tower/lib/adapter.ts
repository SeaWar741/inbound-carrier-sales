import "server-only";
import { z } from "zod";
import {
  adapterWallResponse,
  autonomyModes,
  confirmHoldResponse,
  releaseHoldResponse,
  type AdapterWallResponse,
  type AutonomyMode,
  type ConfirmHoldResponse,
  type ErrorResponse,
  type ReleaseHoldResponse,
} from "./contracts";
import { env } from "./env";

// Calls to the adapter's operator API. Every answer is parsed; anything unexpected becomes a 503
// so an adapter error body never reaches the browser.

const readTimeoutMs = 5_000;
// A confirm books the load in the TMS, which retries on its own before answering.
const confirmTimeoutMs = 30_000;

type AdapterResult<T> = { ok: true; httpStatus: number; body: T } | { ok: false; httpStatus: number; body: ErrorResponse };

const unavailable = (message: string): AdapterResult<never> => ({
  ok: false,
  httpStatus: 503,
  body: { status: "service_unavailable", message },
});

async function call(path: string, init: RequestInit & { timeoutMs: number }): Promise<Response | undefined> {
  const { ADAPTER_URL, OPERATOR_API_KEY } = env();
  const { timeoutMs, headers, ...rest } = init;
  try {
    return await fetch(new URL(path, ADAPTER_URL), {
      ...rest,
      headers: { "x-api-key": OPERATOR_API_KEY, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    return undefined;
  }
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

export async function getWall(): Promise<AdapterResult<AdapterWallResponse>> {
  const response = await call("/v1/operator/wall", { method: "GET", timeoutMs: readTimeoutMs });
  if (!response?.ok) return unavailable("The call data is unavailable right now. Retry shortly.");
  const parsed = adapterWallResponse.safeParse(await json(response));
  if (!parsed.success) return unavailable("The call data is unavailable right now. Retry shortly.");
  return { ok: true, httpStatus: 200, body: parsed.data };
}

export type InterventionRecord =
  | { kind: "whisper" | "listen" | "takeover"; message?: string }
  | { kind: "authorization"; loadId: string; amountUsd: number; message?: string };

const recordedResponse = z.object({ status: z.literal("recorded"), id: z.uuid() });

export async function recordIntervention(callId: string, record: InterventionRecord): Promise<AdapterResult<{ id: string }>> {
  const response = await call(`/v1/operator/calls/${encodeURIComponent(callId)}/interventions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
    timeoutMs: readTimeoutMs,
  });
  if (response?.status === 404) return { ok: false, httpStatus: 404, body: { status: "not_found", message: "No call with that id." } };
  if (response?.status === 400) {
    return { ok: false, httpStatus: 400, body: { status: "invalid_request", message: "The adapter refused this intervention." } };
  }
  if (!response?.ok) return unavailable("The intervention was not recorded. Retry shortly.");
  const parsed = recordedResponse.safeParse(await json(response));
  if (!parsed.success) return unavailable("The intervention was not recorded. Retry shortly.");
  return { ok: true, httpStatus: 200, body: { id: parsed.data.id } };
}

const conflictResponse = z.object({ status: z.literal("conflict"), message: z.string() });

// The adapter answers 200 with a typed status for every business outcome and 409 for a reused key.
async function holdAnswer<T>(response: Response | undefined, schema: z.ZodType<T>, unavailableMessage: string): Promise<AdapterResult<T>> {
  if (response?.status === 409) {
    const parsed = conflictResponse.safeParse(await json(response));
    if (parsed.success) return { ok: false, httpStatus: 409, body: parsed.data };
  }
  if (!response?.ok) return unavailable(unavailableMessage);
  const parsed = schema.safeParse(await json(response));
  if (!parsed.success) return unavailable(unavailableMessage);
  return { ok: true, httpStatus: 200, body: parsed.data };
}

export async function confirmHold(holdId: string, idempotencyKey: string): Promise<AdapterResult<ConfirmHoldResponse>> {
  const response = await call(`/v1/holds/${encodeURIComponent(holdId)}/confirm`, {
    method: "POST",
    headers: { "idempotency-key": idempotencyKey },
    timeoutMs: confirmTimeoutMs,
  });
  return holdAnswer(response, confirmHoldResponse, "The hold service did not answer. Retry with the same Idempotency-Key.");
}

export async function releaseHold(holdId: string): Promise<AdapterResult<ReleaseHoldResponse>> {
  const response = await call(`/v1/holds/${encodeURIComponent(holdId)}/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    timeoutMs: readTimeoutMs,
  });
  return holdAnswer(response, releaseHoldResponse, "The hold service did not answer. Retry the release.");
}

const autonomyAnswer = z.object({ status: z.literal("ok"), mode: z.enum(autonomyModes) });

export async function setAutonomy(mode: AutonomyMode): Promise<AdapterResult<{ mode: AutonomyMode }>> {
  const response = await call("/v1/operator/settings/autonomy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
    timeoutMs: readTimeoutMs,
  });
  if (!response?.ok) return unavailable("The mode was not saved. Retry shortly.");
  const parsed = autonomyAnswer.safeParse(await json(response));
  if (!parsed.success) return unavailable("The mode was not saved. Retry shortly.");
  return { ok: true, httpStatus: 200, body: { mode: parsed.data.mode } };
}
