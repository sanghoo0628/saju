import "server-only";
import type { FortuneCache, ReadyFortuneResult } from "./types";

/** Process-local, bounded development cache. It is neither a database nor a session. */
export class MemoryFortuneCache implements FortuneCache {
  private readonly entries = new Map<string, { value: ReadyFortuneResult; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    if (maxEntries < 1 || ttlMs < 1) throw new Error("Cache capacity and TTL must be positive.");
  }

  async get(key: string): Promise<ReadyFortuneResult | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return structuredClone(entry.value);
  }

  async set(key: string, value: ReadyFortuneResult): Promise<void> {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value: structuredClone(value), expiresAt: this.now() + this.ttlMs });
  }
}
