import { z } from "zod";
import { twinRequestTimeoutMs } from "../constants.ts";

// Twin is Postgres behind `POST /twin/sql`. It takes no bind parameters, so values are
// rendered as escaped literals by `sql`; identifiers are never interpolated.

type SqlScalar = string | number | boolean | null | Date;
// A list renders as comma-separated literals for `IN (...)`; an empty list renders NULL, which matches nothing.
export type SqlValue = SqlScalar | readonly SqlScalar[];

export type SqlStatement = { readonly text: string };

function literal(value: SqlValue): string {
  if (value instanceof Date || typeof value !== "object" || value === null) return scalarLiteral(value);
  return value.length === 0 ? "NULL" : value.map(scalarLiteral).join(", ");
}

function scalarLiteral(value: SqlScalar): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number in SQL: ${value}`);
    return String(value);
  }
  const text = value instanceof Date ? value.toISOString() : value;
  if (text.includes("\0")) throw new TypeError("NUL byte in SQL literal");
  // Twin reported standard_conforming_strings = on when checked on 2026-09-29, but an E-string
  // reads backslashes the same way under either setting, so the escape does not depend on it.
  return `E'${text.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

export function sql(strings: TemplateStringsArray, ...values: SqlValue[]): SqlStatement {
  return { text: strings.reduce((acc, part, i) => acc + literal(values[i - 1] ?? null) + part) };
}

const sqlResponseSchema = z.object({
  command: z.string(),
  rowCount: z.number().nullable(),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});

const errorResponseSchema = z.object({ message: z.string() });

const twinBaseUrl = "https://platform.happyrobot.ai/api/v2";

export class TwinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwinError";
  }
  get isUniqueViolation(): boolean {
    return this.message.includes("duplicate key value violates unique constraint");
  }
}

export type TwinClientOptions = {
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class TwinClient {
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: TwinClientOptions) {
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? twinRequestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async query<T>(statement: SqlStatement, rowSchema: z.ZodType<T>): Promise<T[]> {
    const response = await this.#fetch(`${twinBaseUrl}/twin/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ sql: statement.text }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body);
      throw new TwinError(parsed.success ? parsed.data.message : `HTTP ${response.status}`);
    }
    const result = sqlResponseSchema.parse(body);
    // A truncated read would silently drop rows; every query here is keyed, so treat it as a bug.
    if (result.truncated) throw new TwinError(`Truncated result for: ${statement.text.slice(0, 80)}`);
    return z.array(rowSchema).parse(result.rows);
  }
}
