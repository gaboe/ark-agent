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

  /** Drop windows that have expired, so one IP per request cannot grow forever. */
  private sweep(t: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (t - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}
