import { z } from "zod";
import { tripVendorTimeoutMs } from "../constants.ts";

// EIA API v2, weekly retail No 2 diesel. There is no official SDK, so this is the only raw fetch to EIA.

const dieselAreas = ["NUS", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R50", "SCA"] as const;

// EIA sends prices as strings ("6.382").
const rowSchema = z.object({ period: z.string(), duoarea: z.string(), value: z.coerce.number().positive() });
const responseSchema = z.object({ response: z.object({ data: z.array(rowSchema) }) });

const eiaPath = "/v2/petroleum/pri/gnd/data/";
const eiaBaseUrl = "https://api.eia.gov";
// Three weeks per area, so an area whose latest week is late still has a price.
const rowsRequested = dieselAreas.length * 3;

export class EiaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EiaError";
  }
}

export type EiaClientOptions = {
  apiKey: string;
  fetch?: typeof fetch;
};

export class EiaClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: EiaClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  // Latest $/gal per area. One call returns every area; rows come newest first, so the first row
  // seen for an area is its latest week.
  async latestDieselPrices(): Promise<Map<string, number>> {
    const params = new URLSearchParams({
      api_key: this.#apiKey,
      frequency: "weekly",
      "data[0]": "value",
      "facets[product][]": "EPD2D",
      "sort[0][column]": "period",
      "sort[0][direction]": "desc",
      length: String(rowsRequested),
    });
    for (const area of dieselAreas) params.append("facets[duoarea][]", area);

    // Errors carry only the path: the key rides in the query string and must never be logged.
    let response: Response;
    try {
      response = await this.#fetch(`${eiaBaseUrl}${eiaPath}?${params}`, { signal: AbortSignal.timeout(tripVendorTimeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new EiaError(`${eiaPath}: request failed (${reason})`);
    }
    if (!response.ok) throw new EiaError(`${eiaPath}: HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new EiaError(`${eiaPath}: unexpected response shape`);

    const prices = new Map<string, number>();
    for (const row of parsed.data.response.data) if (!prices.has(row.duoarea)) prices.set(row.duoarea, row.value);
    if (prices.size === 0) throw new EiaError(`${eiaPath}: no prices`);
    return prices;
  }
}
