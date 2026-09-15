/**
 * Environment parsing that fails closed.
 *
 * `Number(x) ?? default` only guards *unset*, never *malformed*: a typo like
 * SPEND_PER_TX_SAT=abc yields NaN, and every comparison against NaN is false,
 * so the cap silently disappears. For a wallet's only spending control that is
 * the worst possible failure direction, so anything unparseable stops the
 * process at startup instead.
 */

export function intFromEnv(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
  }
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * Scope keys. Short keys are rejected because the rate limiter is not a
 * meaningful brute-force defence, and duplicates are rejected because two equal
 * keys would silently grant the lower scope everything the higher one has.
 */
export function keysFromEnv(
  names: Record<string, string>,
  minLength = 20,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const seen = new Map<string, string>();

  for (const [scope, envName] of Object.entries(names)) {
    const value = process.env[envName];
    if (!value) {
      out[scope] = null;
      continue;
    }
    if (value.length < minLength) {
      throw new Error(`${envName} must be at least ${minLength} characters`);
    }
    const clash = seen.get(value);
    if (clash) {
      throw new Error(`${envName} has the same value as ${clash}; scopes would collapse`);
    }
    seen.set(value, envName);
    out[scope] = value;
  }
  return out;
}
