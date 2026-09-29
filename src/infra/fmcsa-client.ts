import { z } from "zod";
import { verificationRequestTimeoutMs } from "../constants.ts";

// FMCSA QCMobile. Fields are optional on purpose: a field QCMobile stops sending must reach
// the policy as "unknown" instead of failing the parse and hiding the rest of the record.

const flag = z.string().nullish();

const carrierSchema = z.object({
  dotNumber: z.number().int(),
  legalName: z.string().nullish(),
  dbaName: z.string().nullish(),
  allowedToOperate: flag,
  bipdInsuranceOnFile: flag,
  safetyRating: flag,
});
export type FmcsaCarrier = z.infer<typeof carrierSchema>;

const authoritySchema = z.object({
  docketNumber: z.number().int().nullish(),
  prefix: z.string().nullish(),
  authorizedForProperty: flag,
  commonAuthorityStatus: flag,
  contractAuthorityStatus: flag,
});
export type FmcsaAuthority = z.infer<typeof authoritySchema>;

const outOfServiceSchema = z.object({
  oosDate: z.string().nullish(),
  oosReason: z.string().nullish(),
});
export type FmcsaOutOfService = z.infer<typeof outOfServiceSchema>;

// An unknown DOT answers 200 with `content: null`; an unknown docket answers `content: []`.
const carrierResponseSchema = z.object({ content: z.object({ carrier: carrierSchema }).nullable() });
const docketResponseSchema = z.object({ content: z.array(z.object({ carrier: carrierSchema })) });
const authorityResponseSchema = z.object({ content: z.array(z.object({ carrierAuthority: authoritySchema })) });
// Rescinded orders drop out of this list, so every entry is an active out-of-service order.
const outOfServiceResponseSchema = z.object({ content: z.array(z.object({ oos: outOfServiceSchema })) });

export class FmcsaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FmcsaError";
  }
}

export type FmcsaClientOptions = {
  webKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class FmcsaClient {
  readonly #webKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: FmcsaClientOptions) {
    this.#webKey = options.webKey;
    this.#baseUrl = options.baseUrl ?? "https://mobile.fmcsa.dot.gov/qc/services";
    this.#timeoutMs = options.timeoutMs ?? verificationRequestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async carrierByDot(dotNumber: string): Promise<FmcsaCarrier | null> {
    const body = await this.#get(`/carriers/${dotNumber}`, carrierResponseSchema);
    return body.content?.carrier ?? null;
  }

  // One docket can map to several DOT records; the caller decides what an ambiguous match means.
  async carriersByDocket(mcNumber: string): Promise<FmcsaCarrier[]> {
    const body = await this.#get(`/carriers/docket-number/${mcNumber}`, docketResponseSchema);
    return body.content.map((entry) => entry.carrier);
  }

  async authorities(dotNumber: string): Promise<FmcsaAuthority[]> {
    const body = await this.#get(`/carriers/${dotNumber}/authority`, authorityResponseSchema);
    return body.content.map((entry) => entry.carrierAuthority);
  }

  async outOfServiceOrders(dotNumber: string): Promise<FmcsaOutOfService[]> {
    const body = await this.#get(`/carriers/${dotNumber}/oos`, outOfServiceResponseSchema);
    return body.content.map((entry) => entry.oos);
  }

  // Errors carry only the path: the web key rides in the query string and must never be logged.
  async #get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = `${this.#baseUrl}${path}?webKey=${encodeURIComponent(this.#webKey)}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown error";
      throw new FmcsaError(`${path}: request failed (${reason})`);
    }
    if (!response.ok) throw new FmcsaError(`${path}: HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new FmcsaError(`${path}: unexpected response shape`);
    return parsed.data;
  }
}
