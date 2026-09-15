/**
 * Fixed-window rate limiter, per client key.
 *
 * Written here rather than pulled in: `elysia-rate-limit` declares a peer
 * dependency on `elysia >= 2.0.0`, which is not a released version — installing
 * it against Elysia 1.4 crashes at startup with `plugin.beforeHandle is
 * undefined`. Twenty lines with a test is cheaper than a dependency that is
 * ahead of the framework it plugs into.
 *
 * Fixed windows allow a burst of up to 2×max across a boundary. That is fine
 * here: the limit exists to bound abuse of a wallet API, not to meter billing.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
    /**
     * Hard ceiling on tracked keys. Without it, a caller varying its key every
     * request grows the map without bound and makes each sweep scan entries
     * that have not expired yet — quadratic work on top of the memory.
     */
    private maxKeys = 10_000,
  ) {}

  /** True when the request is allowed. */
  allow(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);

    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t });
      this.sweep(t);
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  private sweep(t: number): void {
    if (this.hits.size < this.maxKeys) return;

    for (const [key, entry] of this.hits) {
      if (t - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }

    // Still full: every entry is live, which means keys are being fabricated.
    // Map iterates in insertion order, so dropping from the front evicts the
    // oldest. Losing their counts is acceptable; unbounded growth is not.
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
  }
}
