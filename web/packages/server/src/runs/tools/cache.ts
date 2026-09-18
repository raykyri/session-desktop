// A bounded time-to-live cache shared by `web_search` and `web_fetch`
// (`04-agent-runtime.md` §6).
//
// In memory rather than in SQLite: the cache exists so that a model looping
// over the same query inside one run, and two runs on the same topic minutes
// apart, do not pay the vendor twice. Nothing downstream needs it to survive a
// deploy, and a table would put a write on the hot path of every tool call and
// need its own eviction job.

export const TOOL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Least-recently-used with an expiry, which `Map`'s insertion order gives
 * for free: re-inserting on read moves a key to the end, so the first key is
 * always the coldest. */
export class ToolCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: CacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    this.#ttlMs = options.ttlMs ?? TOOL_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}
