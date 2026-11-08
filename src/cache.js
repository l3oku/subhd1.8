export class TtlCache {
  constructor({ ttlMs = 60_000, maxEntries = 1000, maxBytes = 0, sizeOf = null } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.bytes = 0;
    this.items = new Map();
    this.pending = new Map();
  }

  measure(value) {
    if (!this.sizeOf) return 0;
    try {
      return Number(this.sizeOf(value)) || 0;
    } catch {
      return 0;
    }
  }

  get(key) {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.delete(key);

    const size = this.measure(value);
    while (
      this.items.size >= this.maxEntries ||
      (this.maxBytes > 0 && this.bytes + size > this.maxBytes && this.items.size > 0)
    ) {
      const oldest = this.items.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }

    this.items.set(key, { value, size, expires: Date.now() + ttlMs });
    this.bytes += size;
    return value;
  }

  delete(key) {
    const hit = this.items.get(key);
    if (!hit) return false;
    this.bytes -= hit.size || 0;
    this.items.delete(key);
    return true;
  }

  async wrap(key, producer, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const task = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, task);
    return task;
  }
}
