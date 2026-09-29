import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TwinClient, TwinError, sql } from "../src/infra/twin-client.ts";
import { holdRowSchema } from "../src/infra/twin-schemas.ts";

describe("sql", () => {
  it("renders escaped literals", () => {
    const at = new Date("2026-09-28T12:00:00Z");
    expect(sql`SELECT ${"O'Brien"}, ${42}, ${true}, ${null}, ${at}`.text).toBe(
      "SELECT 'O''Brien', 42, TRUE, NULL, '2026-09-28T12:00:00.000Z'",
    );
  });

  it("keeps an injection attempt inside one literal", () => {
    expect(sql`WHERE call_id = ${"x'; DROP TABLE calls; --"}`.text).toBe(
      "WHERE call_id = 'x''; DROP TABLE calls; --'",
    );
  });

  it("rejects values Postgres cannot hold safely", () => {
    expect(() => sql`${Number.NaN}`).toThrow(TypeError);
    expect(() => sql`${"a\0b"}`).toThrow(TypeError);
  });
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const okBody = (rows: unknown[]) => ({ command: "SELECT", rowCount: rows.length, rows, truncated: false });

describe("TwinClient", () => {
  it("posts the statement and parses rows into camelCase", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, okBody([{
        hold_id: "h1", call_id: "c1", load_id: "LD00001", mc_number: null, agreed_rate: "2100",
        status: "held", booking_ref: null, idempotency_key: null,
        created_at: "2026-09-28T12:00:00.000Z", updated_at: "2026-09-28T12:00:00.000Z",
      }])),
    );
    const twin = new TwinClient({ apiKey: "k", fetch: fetchMock });
    const [hold] = await twin.query(sql`SELECT * FROM holds WHERE hold_id = ${"h1"}`, holdRowSchema);

    expect(hold).toMatchObject({ holdId: "h1", agreedRate: 2100, status: "held" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://platform.happyrobot.ai/api/v2/twin/sql");
    expect(init?.body).toBe(JSON.stringify({ sql: "SELECT * FROM holds WHERE hold_id = 'h1'" }));
  });

  it("surfaces unique violations as a typed error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(400, { message: "duplicate key value violates unique constraint \"offers_call_id_load_id_round_key\"" }),
    );
    const twin = new TwinClient({ apiKey: "k", fetch: fetchMock });
    const error = await twin.query(sql`INSERT INTO offers DEFAULT VALUES`, z.unknown()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwinError);
    expect(error instanceof TwinError && error.isUniqueViolation).toBe(true);
  });

  it("refuses a truncated result instead of returning partial rows", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { ...okBody([]), truncated: true }));
    const twin = new TwinClient({ apiKey: "k", fetch: fetchMock });
    await expect(twin.query(sql`SELECT 1`, z.unknown())).rejects.toThrow(TwinError);
  });

  it("rejects rows that do not match the schema", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, okBody([{ hold_id: "h1" }])));
    const twin = new TwinClient({ apiKey: "k", fetch: fetchMock });
    await expect(twin.query(sql`SELECT 1`, holdRowSchema)).rejects.toThrow(z.ZodError);
  });
});
