import { tmsHealthLatencySamples } from "../../constants.ts";
import type { TmsExchange } from "./tms-client.ts";

export type TmsHealthSnapshot = {
  since: string;
  attempts: number;
  retries: number;
  faultsAbsorbed: number;
  latencySamples: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

// Nearest-rank percentile over an ascending list.
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(Math.ceil(p * sorted.length) - 1, 0)] ?? null;
}

// Counts every TMS attempt since process start, fed by TmsClient's onExchange.
export class TmsHealthRecorder {
  readonly #since: Date;
  readonly #capacity: number;
  readonly #latencies: number[] = [];
  #next = 0;
  #attempts = 0;
  #retries = 0;
  #faultsAbsorbed = 0;

  constructor(options: { capacity?: number; now?: Date } = {}) {
    this.#capacity = options.capacity ?? tmsHealthLatencySamples;
    this.#since = options.now ?? new Date();
  }

  record(exchange: Pick<TmsExchange, "attempt" | "latencyMs" | "outcome">): void {
    this.#attempts++;
    if (exchange.attempt > 1) this.#retries++;
    // A command retries only after a fault, so an ok on attempt n absorbed n - 1 faults.
    if (exchange.outcome === "ok") this.#faultsAbsorbed += exchange.attempt - 1;
    if (this.#latencies.length < this.#capacity) this.#latencies.push(exchange.latencyMs);
    else this.#latencies[this.#next] = exchange.latencyMs;
    this.#next = (this.#next + 1) % this.#capacity;
  }

  snapshot(): TmsHealthSnapshot {
    const sorted = this.#latencies.toSorted((a, b) => a - b);
    return {
      since: this.#since.toISOString(),
      attempts: this.#attempts,
      retries: this.#retries,
      faultsAbsorbed: this.#faultsAbsorbed,
      latencySamples: sorted.length,
      latencyP50Ms: percentile(sorted, 0.5),
      latencyP95Ms: percentile(sorted, 0.95),
    };
  }
}
