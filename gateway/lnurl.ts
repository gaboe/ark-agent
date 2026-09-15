/**
 * Lightning address support (LUD-16 / LUD-06).
 *
 * A Lightning address is just a well-known URL: `agent@pay.gaboe.xyz` resolves
 * to `https://pay.gaboe.xyz/.well-known/lnurlp/agent`. That endpoint returns
 * payment parameters, and the same URL with `?amount=` returns a bolt11
 * invoice.
 *
 * Known deviation: LUD-06 requires the invoice to carry `description_hash`
 * (tag `h`) equal to sha256 of the metadata. barkd cannot set it — it only
 * accepts a plain description, and the invoices it produces carry tag `d`.
 * Wallets that verify the hash will reject these invoices.
 *
 * This is shipped anyway because the incumbent has the same flaw: decoding an
 * invoice from `gabo@noahwallet.io`, which is served by Noah's own barkd, shows
 * `d(60)` and no `h`. So this is no worse than the address it replaces, and it
 * becomes correct for free if barkd ever gains description_hash support.
 */

export interface LnurlConfig {
  /** The part before the @. */
  name: string;
  /** The part after the @. */
  domain: string;
  minSendableMsat: number;
  maxSendableMsat: number;
}

export function lightningAddress(cfg: LnurlConfig): string {
  return `${cfg.name}@${cfg.domain}`;
}

/** LUD-06 metadata. The exact string matters: it is what the hash would cover. */
export function metadataString(cfg: LnurlConfig): string {
  const address = lightningAddress(cfg);
  return JSON.stringify([
    ["text/identifier", address],
    ["text/plain", `Paying satoshis to ${address}`],
  ]);
}

export function payRequestParams(cfg: LnurlConfig) {
  return {
    callback: `https://${cfg.domain}/.well-known/lnurlp/${cfg.name}`,
    minSendable: cfg.minSendableMsat,
    maxSendable: cfg.maxSendableMsat,
    metadata: metadataString(cfg),
    commentAllowed: 0,
    tag: "payRequest",
  };
}

export type AmountResult =
  | { ok: true; sats: number }
  | { ok: false; reason: string };

/**
 * LNURL amounts are in millisatoshis. Ark cannot settle sub-satoshi amounts, so
 * anything that is not a whole number of sats is refused rather than rounded —
 * silently changing what someone is paying is worse than making them retry.
 */
export function parseAmountMsat(raw: string | undefined, cfg: LnurlConfig): AmountResult {
  if (raw === undefined || raw === "") return { ok: false, reason: "amount is required" };

  const msat = Number(raw);
  if (!Number.isFinite(msat) || !Number.isInteger(msat) || msat <= 0) {
    return { ok: false, reason: "amount must be a positive whole number of millisatoshis" };
  }
  if (msat < cfg.minSendableMsat || msat > cfg.maxSendableMsat) {
    return {
      ok: false,
      reason: `amount must be between ${cfg.minSendableMsat} and ${cfg.maxSendableMsat} msat`,
    };
  }
  if (msat % 1000 !== 0) {
    return { ok: false, reason: "amount must be a whole number of satoshis" };
  }
  return { ok: true, sats: msat / 1000 };
}

/** LUD-06 error shape. Wallets look for `status`, not an HTTP code. */
export function lnurlError(reason: string) {
  return { status: "ERROR", reason };
}
