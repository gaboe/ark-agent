/**
 * Spending policy. Kept separate from the HTTP layer so it can be tested
 * without a server, and so the rules are readable in one place.
 *
 * State lives in memory: a restart resets the day's tally. That is a deliberate
 * trade — a process that crashes repeatedly could spend more than the cap in a
 * day, but the alternative is a database for a wallet holding a few thousand
 * sats. If the balance grows, this is the first thing to fix.
 */

export type Scope = "read" | "invoice" | "spend";

export const SCOPE_ORDER: Scope[] = ["read", "invoice", "spend"];

/** Higher scopes include the lower ones. */
export function scopeAllows(held: Scope, needed: Scope): boolean {
  return SCOPE_ORDER.indexOf(held) >= SCOPE_ORDER.indexOf(needed);
}

export interface SpendLimits {
  perTxSat: number;
  perDaySat: number;
  /** Empty means "any destination". */
  allowedDestinations: string[];
}

export class SpendTracker {
  private spentToday = 0;
  private day = utcDay();

  constructor(private limits: SpendLimits) {}

  /**
   * Reserve quota for a payment about to be attempted.
   *
   * Reserving up front rather than recording afterwards is what makes the cap
   * hold under concurrency: the check and the increment happen in one
   * synchronous step, so two requests cannot both pass while the tally is
   * stale. Every reservation must be settled with `commit` or `release`.
   *
   * Returns null when allowed, or a human-readable reason when not.
   */
  reserve(amountSat: number, destination: string): string | null {
    this.rollOver();

    if (!Number.isInteger(amountSat) || amountSat <= 0) {
      return "amount must be a positive whole number of sats";
    }
    if (amountSat > this.limits.perTxSat) {
      return `amount ${amountSat} exceeds per-transaction limit ${this.limits.perTxSat}`;
    }
    if (this.spentToday + amountSat > this.limits.perDaySat) {
      return `amount ${amountSat} would exceed the daily limit ${this.limits.perDaySat} (${this.spentToday} already spent today)`;
    }
    const allowed = this.limits.allowedDestinations;
    if (allowed.length > 0 && !allowed.includes(destination)) {
      return "destination is not on the allowlist";
    }

    this.spentToday += amountSat;
    return null;
  }

  /** The payment went through; the reservation stands. */
  commit(_amountSat: number): void {
    // Intentionally empty: `reserve` already charged the quota. Kept as an
    // explicit call site so the settle-every-reservation rule is visible.
  }

  /** The payment did not go through; give the quota back. */
  release(amountSat: number): void {
    this.rollOver();
    this.spentToday = Math.max(this.spentToday - amountSat, 0);
  }

  status() {
    this.rollOver();
    return {
      spent_today_sat: this.spentToday,
      remaining_today_sat: Math.max(this.limits.perDaySat - this.spentToday, 0),
      per_tx_limit_sat: this.limits.perTxSat,
      per_day_limit_sat: this.limits.perDaySat,
      destination_allowlist: this.limits.allowedDestinations,
    };
  }

  private rollOver(): void {
    const today = utcDay();
    if (today !== this.day) {
      this.day = today;
      this.spentToday = 0;
    }
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}
