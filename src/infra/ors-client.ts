import { z } from "zod";
import { tripVendorTimeoutMs } from "../constants.ts";

// openrouteservice-js 0.4.1 runs under Node ESM but ships no types and calls the global fetch, so raw fetch keeps types strict and fetch injectable.

export type LngLat = readonly [lng: number, lat: number];

// extras.tollways.summary: value 1 is tolled; amount is the percent of the route, not money.
const routeSchema = z.object({
  summary: z.object({ distance: z.number().positive(), duration: z.number().positive() }),
  extras: z
    .object({ tollways: z.object({ summary: z.array(z.object({ value: z.number(), amount: z.number() })) }) })
    .partial()
    .optional(),
});
const responseSchema = z.object({ routes: z.array(routeSchema) });

const orsPath = "/v2/directions/driving-hgv";
const orsBaseUrl = "https://api.openrouteservice.org";

export type OrsRoute = { distanceMi: number; durationS: number; tollShare: number };

export class OrsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrsError";
  }
}

export type OrsClientOptions = {
  apiKey: string;
  fetch?: typeof fetch;
};

export class OrsClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: OrsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  // Heavy goods vehicle route. radiuses -1 asks for the largest snap the server allows, which the public
  // API caps at 350 m, so a rural ZIP3 centroid can still miss every road and answer 404.
  async route(from: LngLat, to: LngLat): Promise<OrsRoute> {
    let response: Response;
    try {
      response = await this.#fetch(`${orsBaseUrl}${orsPath}`, {
        method: "POST",
        headers: { authorization: this.#apiKey, "content-type": "application/json" },
        body: JSON.stringify({ coordinates: [from, to], extra_info: ["tollways"], units: "mi", radiuses: [-1, -1] }),
        signal: AbortSignal.timeout(tripVendorTimeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new OrsError(`${orsPath}: request failed (${reason})`);
    }
    if (!response.ok) throw new OrsError(`${orsPath}: HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    const route = parsed.success ? parsed.data.routes[0] : undefined;
    if (!route) throw new OrsError(`${orsPath}: unexpected response shape`);

    const tolledPercent = (route.extras?.tollways?.summary ?? [])
      .filter((part) => part.value === 1)
      .reduce((sum, part) => sum + part.amount, 0);
    return {
      distanceMi: route.summary.distance,
      durationS: route.summary.duration,
      tollShare: Math.min(1, tolledPercent / 100),
    };
  }
}
