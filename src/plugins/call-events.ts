import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { dollars } from "../domain/negotiation.ts";
import { sql, type TwinClient } from "../infra/twin-client.ts";

// Writes one call_events row per named agent tool call (see toolNames) so the operator wall can follow the call.
// The write starts after the response is sent and is never awaited: a slow or failing Twin
// never changes what the agent hears or how fast it hears it.

export type CallEventDeps = { twin: Pick<TwinClient, "query"> };

const toolNames: Record<string, string> = {
  "/carriers/verify": "verify_carrier",
  "/otp/send": "send_otp",
  "/otp/check": "check_otp",
  "/loads/search": "search_loads",
  "/offers/evaluate": "evaluate_offer",
  "/holds": "create_hold",
};

// Only the routes named above are recorded. request_human is absent on purpose: its route
// awaits its own row, because the agent may promise a rep only once the operator can see it.
export function toolName(routeUrl: string): string | null {
  const path = routeUrl.replace(/^\/v1(?=\/)/, "");
  return toolNames[path] ?? null;
}

// Before validation the body is whatever the agent sent, so every field is read defensively.
const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
const usd = (value: unknown) => {
  const amount = typeof value === "string" ? Number(value) : value;
  return typeof amount === "number" && Number.isInteger(amount) && amount > 0 ? dollars(amount) : undefined;
};
const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

type Fields = Record<string, unknown>;

// Built from the request body and the agent-facing response only, so it can never carry the max buy.
export function summarize(tool: string, body: Fields, response: Fields): string | null {
  switch (tool) {
    case "verify_carrier": {
      const mc = text(body.mcNumber);
      const dot = text(body.dotNumber);
      return mc ? `Verifying MC ${mc}` : dot ? `Verifying DOT ${dot}` : "Verifying carrier";
    }
    case "send_otp": {
      const channel = text(body.channel);
      return channel ? `Sending verification code by ${channel}` : "Sending verification code";
    }
    case "check_otp":
      return "Checking verification code";
    case "search_loads": {
      const place = [text(body.originCity), text(body.originState)].filter(Boolean).join(", ") || text(body.originZip);
      return place ? `Searching loads near ${place}` : "Searching loads";
    }
    case "evaluate_offer": {
      const ask = usd(body.carrierAsk);
      const decision = text(response.decision);
      const round = typeof response.round === "number" ? response.round : undefined;
      const head = decision && round ? `${capitalized(decision)} round ${round}` : `Offer on ${text(body.loadId) ?? "a load"}`;
      return ask ? `${head}: carrier asks ${ask}` : head;
    }
    case "create_hold": {
      const load = text(body.loadId) ?? "a load";
      const rate = usd(body.agreedRate);
      return rate ? `Holding load ${load} at ${rate}` : `Holding load ${load}`;
    }
    default:
      return null;
  }
}

const callIdField = z.string().trim().min(1).max(128);
export const maxSummaryLength = 200;

const asFields = (value: unknown): Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};

function parsedPayload(payload: unknown): Fields {
  if (typeof payload !== "string") return {};
  try {
    return asFields(JSON.parse(payload));
  } catch {
    return {};
  }
}

export function recordCallEvents(scope: FastifyInstance, deps: CallEventDeps): void {
  const responses = new WeakMap<FastifyRequest, Fields>();

  // The serialized body is the only place the response status is visible to a hook.
  scope.addHook("onSend", async (request, _reply, payload) => {
    responses.set(request, parsedPayload(payload));
    return payload;
  });

  scope.addHook("onResponse", async (request) => {
    const routeUrl = request.routeOptions.url;
    const body = asFields(request.body);
    const callId = callIdField.safeParse(body.callId);
    // Unauthorized or unrouted requests have no call to attach the event to.
    if (routeUrl === undefined || !callId.success) return;

    const tool = toolName(routeUrl);
    if (tool === null) return;

    const response = responses.get(request) ?? {};
    const summary = summarize(tool, body, response)?.slice(0, maxSummaryLength) ?? null;
    const status = typeof response.status === "string" ? response.status : null;

    // Building the statement inside the chain keeps even a rejected literal off the request path.
    void Promise.resolve()
      .then(() =>
        deps.twin.query(
          sql`INSERT INTO call_events (call_id, tool, summary, status) VALUES (${callId.data}, ${tool}, ${summary}, ${status})`,
          z.unknown(),
        ),
      )
      .catch((error: unknown) => request.log.warn({ err: error, tool }, "call event not recorded"));
  });
}
