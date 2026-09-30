import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OrsClient, OrsError } from "../src/infra/ors-client.ts";

// Real driving-hgv route for ZIP3 984 (Tacoma) to 212 (Baltimore), geometry and steps removed.
const tacomaBaltimore = JSON.parse(readFileSync(new URL("./fixtures/ors/tacoma-baltimore.json", import.meta.url), "utf8")) as {
  routes: [{ summary: object; extras: object }];
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const clientWith = (fetchImpl: typeof fetch) => new OrsClient({ apiKey: "ors-secret-key", fetch: fetchImpl });
const tacoma = [-122.44, 47.25] as const;
const baltimore = [-76.61, 39.29] as const;

describe("OrsClient.route", () => {
  it("posts an HGV route in miles with toll extras and the key in the header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(tacomaBaltimore));
    await clientWith(fetchMock).route(tacoma, baltimore);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.openrouteservice.org/v2/directions/driving-hgv");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("ors-secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      coordinates: [tacoma, baltimore],
      extra_info: ["tollways"],
      units: "mi",
      radiuses: [-1, -1],
    });
  });

  it("reads distance, duration and the tolled share of the route", async () => {
    const route = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse(tacomaBaltimore))).route(tacoma, baltimore);
    expect(route).toMatchObject({ distanceMi: 2784.065, durationS: 220630.2 });
    expect(route.tollShare).toBeCloseTo(0.2074);
  });

  it("sums every tolled part and treats a route without toll extras as toll free", async () => {
    const summary = { distance: 100, duration: 7200 };
    const parts = [
      { value: 1, distance: 10, amount: 10 },
      { value: 0, distance: 70, amount: 70 },
      { value: 1, distance: 20, amount: 20 },
    ];
    const tolled = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse({ routes: [{ summary, extras: { tollways: { summary: parts } } }] }))).route(tacoma, baltimore);
    expect(tolled.tollShare).toBeCloseTo(0.3);
    const free = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse({ routes: [{ summary }] }))).route(tacoma, baltimore);
    expect(free.tollShare).toBe(0);
  });

  it("raises a typed error with the HTTP status and never the key", async () => {
    const limited = await clientWith(vi.fn<typeof fetch>(async () => jsonResponse({ error: "Rate Limit Exceeded" }, 429)))
      .route(tacoma, baltimore)
      .catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(OrsError);
    expect((limited as OrsError).status).toBe(429);

    const failures: Array<typeof fetch> = [
      async () => jsonResponse({ routes: [] }),
      async () => jsonResponse({ routes: [{ summary: { distance: 0, duration: 0 } }] }),
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ];
    for (const failure of failures) {
      const error = await clientWith(vi.fn(failure)).route(tacoma, baltimore).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OrsError);
      expect(String((error as Error).message)).not.toContain("ors-secret-key");
    }
  });
});
