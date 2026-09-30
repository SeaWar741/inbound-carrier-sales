// Same table the control tower draws with, so the estimate and the map agree on where a ZIP3 is.
import zip3CentroidsJson from "../../control-tower/lib/zip3-centroids.json" with { type: "json" };
import type { Config } from "../config.ts";
import { dieselCacheMs, fallbackDriveMph } from "../constants.ts";
import { tmsWallClockToDate } from "../domain/trip.ts";
import { estimateTrip, laneDieselPerGal, type TripSnapshot } from "../domain/trip-estimate.ts";
import { EiaClient } from "./eia-client.ts";
import { OrsClient, type LngLat, type OrsRoute } from "./ors-client.ts";
import type { LoadDetail } from "./tms/codec.ts";

export type Log = { warn: (details: object, message: string) => void };

export type TripEndpoint = { zip: string; state: string };
export type TripRequest = {
  origin: TripEndpoint;
  destination: TripEndpoint;
  miles: number;
  pickupAt: Date;
  deliveryAt: Date;
  rate: number;
};

// [longitude, latitude] per 3-digit ZIP prefix.
export const zip3Centroids: ReadonlyMap<string, LngLat> = new Map(
  Object.entries(zip3CentroidsJson).flatMap(([zip3, [lng, lat]]): [string, LngLat][] =>
    lng === undefined || lat === undefined ? [] : [[zip3, [lng, lat]]],
  ),
);

export type TripEstimatorOptions = {
  eia?: EiaClient;
  ors?: OrsClient;
  centroids: ReadonlyMap<string, LngLat>;
  now?: () => number;
};

// Adds cost and legal time to a load without ever failing the tool call around it: any vendor error,
// timeout or unknown ZIP3 answers null and the agent pitches the load without an estimate.
export class TripEstimator {
  readonly #eia: EiaClient | undefined;
  readonly #ors: OrsClient | undefined;
  readonly #centroids: ReadonlyMap<string, LngLat>;
  readonly #now: () => number;
  // No expiry: roads do not change between calls, and the key space is bounded by the board's lanes
  // (at most about 909). Promises are cached so parallel estimates on one lane share a request.
  readonly #routes = new Map<string, Promise<OrsRoute>>();
  #diesel: { prices: Promise<Map<string, number>>; fetchedAt: number } | undefined;

  constructor(options: TripEstimatorOptions) {
    this.#eia = options.eia;
    this.#ors = options.ors;
    this.#centroids = options.centroids;
    this.#now = options.now ?? Date.now;
  }

  static fromConfig(config: Pick<Config, "EIA_API_KEY" | "ORS_API_KEY">, centroids = zip3Centroids): TripEstimator {
    const { EIA_API_KEY: eiaKey, ORS_API_KEY: orsKey } = config;
    if (!eiaKey || !orsKey) return new TripEstimator({ centroids });
    return new TripEstimator({ eia: new EiaClient({ apiKey: eiaKey }), ors: new OrsClient({ apiKey: orsKey }), centroids });
  }

  async estimate(trip: TripRequest, log: Log): Promise<TripSnapshot | null> {
    if (!this.#eia || !this.#ors) return null;
    const originZip3 = trip.origin.zip.slice(0, 3);
    const destinationZip3 = trip.destination.zip.slice(0, 3);
    const from = this.#centroids.get(originZip3);
    const to = this.#centroids.get(destinationZip3);
    const ors = this.#ors;
    // Without a route the HOS check still runs at a fixed driving speed and tolls are left out, so an
    // ORS quota or an unroutable lane never switches the window check off.
    const routed = (from && to
      ? this.#route(ors, `${originZip3}-${destinationZip3}`, from, to)
      : Promise.reject(new Error(`unknown ZIP3 ${originZip3}-${destinationZip3}`))
    ).then(
      (route) => ({ avgMph: route.distanceMi / (route.durationS / 3600), tollShare: route.tollShare as number | null }),
      (error: unknown) => {
        log.warn({ err: error, originZip3, destinationZip3 }, "trip route unavailable, using the fallback speed");
        return { avgMph: fallbackDriveMph, tollShare: null };
      },
    );
    try {
      const [route, prices] = await Promise.all([routed, this.#dieselPrices(this.#eia)]);
      const dieselPerGal = laneDieselPerGal(prices, trip.origin.state, trip.destination.state);
      if (dieselPerGal === undefined) {
        log.warn({ origin: trip.origin.state, destination: trip.destination.state }, "trip estimate skipped: no diesel price");
        return null;
      }
      return estimateTrip({
        miles: trip.miles,
        rate: trip.rate,
        pickupAt: trip.pickupAt,
        deliveryAt: trip.deliveryAt,
        avgMph: route.avgMph,
        tollShare: route.tollShare,
        dieselPerGal,
      });
    } catch (error) {
      log.warn({ err: error }, "trip estimate unavailable");
      return null;
    }
  }

  #route(ors: OrsClient, lane: string, from: LngLat, to: LngLat): Promise<OrsRoute> {
    let route = this.#routes.get(lane);
    if (!route) {
      route = ors.route(from, to);
      // A failed lookup is not cached, so the next call on the lane tries again.
      route.catch(() => this.#routes.delete(lane));
      this.#routes.set(lane, route);
    }
    return route;
  }

  #dieselPrices(eia: EiaClient): Promise<Map<string, number>> {
    const now = this.#now();
    if (!this.#diesel || now - this.#diesel.fetchedAt >= dieselCacheMs) {
      const entry = { prices: eia.latestDieselPrices(), fetchedAt: now };
      entry.prices.catch(() => {
        if (this.#diesel === entry) this.#diesel = undefined;
      });
      this.#diesel = entry;
    }
    return this.#diesel.prices;
  }
}

export type TripEstimates = Pick<TripEstimator, "estimate">;

// The load's own lane and TMS window, at whatever rate is on the table.
export function estimateLoadTrip(trips: TripEstimates, load: LoadDetail, rate: number, log: Log): Promise<TripSnapshot | null> {
  return trips.estimate(
    {
      origin: { zip: load.origZip, state: load.origState },
      destination: { zip: load.destZip, state: load.destState },
      miles: load.miles,
      pickupAt: tmsWallClockToDate(load.pickupDateTime),
      deliveryAt: tmsWallClockToDate(load.deliveryDateTime),
      rate,
    },
    log,
  );
}
