import { z } from "zod";
import { verificationRequestTimeoutMs } from "../constants.ts";

// FMCSA Company Census on Socrata (no token). Socrata omits empty columns from each row.

const censusRowSchema = z.object({
  email_address: z.string().optional(),
  phone: z.string().optional(),
  cell_phone: z.string().optional(),
  mcs150_date: z.string().optional(),
});

export type CensusContact = {
  email: string | null;
  phone: string | null;
  cellPhone: string | null;
  mcs150Date: Date | null;
};

// mcs150_date arrives as YYYYMMDD.
function parseCensusDate(value: string | undefined): Date | null {
  const match = value?.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const blankToNull = (value: string | undefined) => (value?.trim() ? value.trim() : null);

export class CensusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CensusError";
  }
}

export type CensusClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class CensusClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: CensusClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "https://data.transportation.gov/resource/az4n-8mr2.json";
    this.#timeoutMs = options.timeoutMs ?? verificationRequestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  // null when the census has no single row for the DOT: a contact we cannot pin down is no contact.
  async contactByDot(dotNumber: string): Promise<CensusContact | null> {
    const url = `${this.#baseUrl}?dot_number=${encodeURIComponent(dotNumber)}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (error) {
      throw new CensusError(`census: request failed (${error instanceof Error ? error.name : "unknown error"})`);
    }
    if (!response.ok) throw new CensusError(`census: HTTP ${response.status}`);
    const parsed = z.array(censusRowSchema).safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new CensusError("census: unexpected response shape");
    const [row, ...rest] = parsed.data;
    if (!row || rest.length > 0) return null;
    return {
      email: blankToNull(row.email_address),
      phone: blankToNull(row.phone),
      cellPhone: blankToNull(row.cell_phone),
      mcs150Date: parseCensusDate(row.mcs150_date),
    };
  }
}
