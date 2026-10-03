// Fixed-window hit counts shared by every tower instance through the adapter, which keeps them in Twin.
// A round trip there is ~170 ms plus the adapter hop, too slow to wait on in front of every API request,
// so `take` answers from what this instance knows (its own hits, or the last total Twin reported,
// whichever is higher) and sends the hit in the background. Over the limit, an instance stops writing:
// a flood never becomes a flood of writes. With the adapter or Twin down, each instance still enforces
// the limit on its own hits. Mirrors the adapter's src/infra/shared-counter.ts.

export type HitStore = (key: string, windowSeconds: number) => Promise<number>;

type Window = { index: number; local: number; shared: number };

export class SharedCounter {
  readonly #store: HitStore;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(store: HitStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  #window(key: string, windowMs: number): Window {
    // Windows align on the epoch, as Twin's do, so every instance counts the same window.
    const index = Math.floor(this.#now() / windowMs);
    const window = this.#windows.get(key);
    if (window?.index === index) return window;
    for (const [k, w] of this.#windows) if (w.index < index - 1) this.#windows.delete(k);
    const fresh = { index, local: 0, shared: 0 };
    this.#windows.set(key, fresh);
    return fresh;
  }

  // Counts one hit; answers this window's count as known now and the ms left in the window.
  take(key: string, limit: number, windowMs: number): { count: number; resetMs: number } {
    const window = this.#window(key, windowMs);
    window.local += 1;
    const count = Math.max(window.local, window.shared + 1);
    if (count <= limit) {
      window.shared = count;
      void this.#store(key, windowMs / 1000)
        .then((total) => {
          if (window.shared < total) window.shared = total;
        })
        .catch(() => undefined);
    }
    return { count, resetMs: (window.index + 1) * windowMs - this.#now() };
  }

  // Counts one hit and waits for the shared total; this instance's count when the store cannot answer.
  // Once the window is known to be over `limit`, the hit stays local, so a flood writes nothing more.
  async takeExact(key: string, limit: number, windowMs: number): Promise<number> {
    const window = this.#window(key, windowMs);
    window.local += 1;
    if (Math.max(window.local - 1, window.shared) >= limit) return Math.max(window.local, window.shared + 1);
    try {
      window.shared = Math.max(window.shared, await this.#store(key, windowMs / 1000));
    } catch {
      // The store is down: this instance's own count stands.
    }
    return Math.max(window.local, window.shared);
  }
}
