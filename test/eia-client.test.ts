import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EiaClient, EiaError } from "../src/infra/eia-client.ts";

// Real EIA v2 weekly diesel payload (2026-09-28 and 2026-09-21), request echo removed.
const weekly: unknown = JSON.parse(readFileSync(new URL("./fixtures/eia/diesel-weekly.json", import.meta.url), "utf8"));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clientWith = (fetchImpl: typeof fetch) => new EiaClient({ apiKey: "eia-secret-key", fetch: fetchImpl });

describe("EiaClient.latestDieselPrices", () => {
  it("asks for weekly EPD2D in every area in one call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(weekly));
    await clientWith(fetchMock).latestDieselPrices();
    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe("https://api.eia.gov/v2/petroleum/pri/gnd/data/");
    expect(url.searchParams.get("frequency")).toBe("weekly");
    expect(url.searchParams.get("data[0]")).toBe("value");
    expect(url.searchParams.get("facets[product][]")).toBe("EPD2D");
    expect(url.searchParams.getAll("facets[duoarea][]")).toEqual(["NUS", "R1X", "R1Y", "R1Z", "R20", "R30", "R40", "R50", "SCA"]);
    expect(url.searchParams.get("sort[0][direction]")).toBe("desc");
  });

  it("keeps the latest week per area as a number", async () => {
    const prices = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse(weekly))).latestDieselPrices();
    expect(prices.size).toBe(9);
    expect(prices.get("NUS")).toBe(6.382);
    expect(prices.get("SCA")).toBe(8.181);
    expect(prices.get("R50")).toBe(7.357);
  });

  it("does not trust the order EIA sends", async () => {
    const rows = [
      { period: "2026-09-21", duoarea: "NUS", value: "6.529" },
      { period: "2026-09-28", duoarea: "NUS", value: "6.382" },
    ];
    const prices = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse({ response: { data: rows } }))).latestDieselPrices();
    expect(prices.get("NUS")).toBe(6.382);
  });

  it("never puts the key in an error", async () => {
    const failures: Array<typeof fetch> = [
      async () => jsonResponse({ error: "API_KEY_INVALID" }, 403),
      async () => jsonResponse({ unexpected: true }),
      async () => jsonResponse({ response: { data: [] } }),
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ];
    for (const failure of failures) {
      const error = await clientWith(vi.fn(failure)).latestDieselPrices().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EiaError);
      expect(String((error as Error).message)).not.toContain("eia-secret-key");
    }
  });
});
