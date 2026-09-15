/**
 * A thin, opinionated front door for barkd.
 *
 * barkd has exactly one bearer token and it can do everything: spend the whole
 * balance, offboard, start an exit, read the wallet's own config. This process
 * holds that token, binds barkd to loopback, and exposes only the handful of
 * operations the agent actually needs — each behind a key with a scope, and
 * spending behind a policy.
 */
import { Elysia, t } from "elysia";
import { createHash, timingSafeEqual } from "node:crypto";

import { SpendTracker, scopeAllows, type Scope } from "./policy";
import { RateLimiter } from "./ratelimit";
import { runKeeperOnce } from "./keeper";
import { intFromEnv, keysFromEnv } from "./config";
import { lightningAddress, lnurlError, parseAmountMsat, payRequestParams, type LnurlConfig } from "./lnurl";

const BARKD = process.env.BARKD_INTERNAL_URL ?? "http://127.0.0.1:3000";
const BARKD_TOKEN = required("BARKD_AUTH_SECRET");
const PORT = Number(process.env.GATEWAY_PORT ?? 3001);

const KEYS = keysFromEnv({
  read: "GATEWAY_READ_KEY",
  invoice: "GATEWAY_INVOICE_KEY",
  spend: "GATEWAY_SPEND_KEY",
}) as Record<Scope, string | null>;

const tracker = new SpendTracker({
  perTxSat: intFromEnv("SPEND_PER_TX_SAT", 10_000, { min: 1 }),
  perDaySat: intFromEnv("SPEND_PER_DAY_SAT", 50_000, { min: 1 }),
  allowedDestinations: (process.env.SPEND_ALLOWED_DESTINATIONS ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean),
});

const LNURL: LnurlConfig = {
  name: process.env.LN_ADDRESS_NAME ?? "agent",
  domain: process.env.LN_ADDRESS_DOMAIN ?? "pay.gaboe.xyz",
  minSendableMsat: intFromEnv("LN_MIN_SENDABLE_MSAT", 1_000, { min: 1000 }),
  maxSendableMsat: intFromEnv("LN_MAX_SENDABLE_MSAT", 10_000_000, { min: 1000 }),
};

/**
 * Our Ark server's pubkey, used to decide whether a caller is close enough to
 * be paid over Ark. Read from barkd at startup rather than configured, so it
 * cannot drift from the server the wallet is actually on.
 */
let ARK_SERVER_PUBKEY: string | null = null;

/** Nothing should hang a request or a keeper run forever. */
const UPSTREAM_TIMEOUT_MS = intFromEnv("UPSTREAM_TIMEOUT_MS", 60_000, { min: 1000 });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** barkd's bearer token is base64url(0x00 || the 32-byte hex secret). */
function barkdBearer(hexSecret: string): string {
  const raw = Buffer.concat([Buffer.from([0]), Buffer.from(hexSecret, "hex")]);
  return raw.toString("base64url");
}
const BARKD_BEARER = barkdBearer(BARKD_TOKEN);

/**
 * Compare by hashing first, so both sides are always 32 bytes and the
 * comparison cannot vary with the presented length. Comparing the raw strings
 * would need a length check, and that check is itself a length oracle.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

/** Returns the highest scope the presented key grants, or null. */
function scopeFor(authorization: string | undefined): Scope | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const presented = authorization.slice("Bearer ".length);
  let found: Scope | null = null;
  // Check every configured key rather than returning on the first match.
  for (const scope of ["read", "invoice", "spend"] as Scope[]) {
    const key = KEYS[scope];
    if (key && constantTimeEqual(presented, key)) found = scope;
  }
  return found;
}

function audit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

async function bark(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BARKD}${path}`, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${BARKD_BEARER}`,
      "content-type": "application/json",
    },
  });
}

/** Proxy a barkd response through unchanged. */
async function passthrough(res: Response) {
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

const guard = (needed: Scope) => (ctx: { headers: Record<string, string | undefined>; set: { status?: number | string } }) => {
  const held = scopeFor(ctx.headers.authorization);
  if (!held || !scopeAllows(held, needed)) {
    audit("denied", { needed, had: held ?? "none" });
    ctx.set.status = 401;
    return { message: "unauthorized" };
  }
  return;
};

const limiter = new RateLimiter(
  Number(process.env.RATE_LIMIT_MAX ?? 60),
  Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
);

const app = new Elysia()
  .onBeforeHandle(({ request, server, set }) => {
    // Caddy *appends* the peer to X-Forwarded-For, so the last element is the
    // one it observed and the only one a client cannot forge. Taking the first
    // would let a caller mint a new rate-limit bucket per request simply by
    // sending its own header.
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",").pop()?.trim()
      || server?.requestIP(request)?.address
      || "unknown";
    if (!limiter.allow(ip)) {
      audit("rate_limited", { ip });
      set.status = 429;
      return { message: "too many requests" };
    }
  })
  .get("/ping", () => "pong")

  // Lightning address (LUD-16). Deliberately unauthenticated: anyone paying has
  // to be able to reach it. Receiving cannot move funds out, so it sits outside
  // the scope system — the global rate limiter is what bounds abuse.
  .get("/.well-known/lnurlp/:name", async ({ params, query, set }) => {
    if (params.name !== LNURL.name) {
      set.status = 404;
      return lnurlError("unknown recipient");
    }

    // Without ?amount this is the first LNURL call: return the parameters.
    if (query.amount === undefined) {
      const params = payRequestParams(LNURL);

      // Ark-aware callers announce themselves with ?ark=<server_pubkey>, and
      // read an `ark` address back out of the response. Noah does both; the
      // convention is not in any LUD, so it is implemented here from its
      // client code. Answering it turns a payment between two clients of the
      // same Ark server from a Lightning round-trip — the server's flat 20 sat
      // minimum — into a free off-chain transfer.
      //
      // The address is only offered to a caller on *this* server: to anyone
      // else it is unspendable, and Noah would rightly discard it.
      if (typeof query.ark === "string" && query.ark === ARK_SERVER_PUBKEY) {
        try {
          const res = await bark("/api/v1/wallet/addresses/next", { method: "POST" });
          if (res.ok) {
            const { address } = (await res.json()) as { address?: string };
            if (address) {
              audit("lnurl_ark_offered");
              return { ...params, ark: address };
            }
          }
        } catch {
          // The Ark rail is an optimisation; never fail the LNURL call over it.
        }
      }
      return params;
    }

    const parsed = parseAmountMsat(query.amount, LNURL);
    if (!parsed.ok) {
      audit("lnurl_refused", { reason: parsed.reason, amount: query.amount });
      set.status = 400;
      return lnurlError(parsed.reason);
    }

    let res: Response;
    try {
      res = await bark("/api/v1/lightning/receives/invoice", {
        method: "POST",
        body: JSON.stringify({
          amount_sat: parsed.sats,
          description: `Paying satoshis to ${lightningAddress(LNURL)}`,
        }),
      });
    } catch (e) {
      audit("lnurl_invoice_error", { error: String(e) });
      set.status = 502;
      return lnurlError("could not create an invoice");
    }

    if (!res.ok) {
      audit("lnurl_invoice_failed", { status: res.status });
      set.status = 502;
      return lnurlError("could not create an invoice");
    }

    const body = (await res.json()) as { invoice?: string };
    if (!body.invoice) {
      audit("lnurl_invoice_missing");
      set.status = 502;
      return lnurlError("could not create an invoice");
    }

    audit("lnurl_invoice", { amount_sat: parsed.sats });
    return { pr: body.invoice, routes: [] };
  })

  .get("/balance", async ({ headers, set }) => {
    const denied = guard("read")({ headers, set }); if (denied) return denied;
    return passthrough(await bark("/api/v1/wallet/balance"));
  })

  .get("/vtxos", async ({ headers, set }) => {
    const denied = guard("read")({ headers, set }); if (denied) return denied;
    return passthrough(await bark("/api/v1/wallet/vtxos"));
  })

  .get("/history", async ({ headers, set }) => {
    const denied = guard("read")({ headers, set }); if (denied) return denied;
    return passthrough(await bark("/api/v1/wallet/history"));
  })

  .get("/limits", ({ headers, set }) => {
    const denied = guard("read")({ headers, set }); if (denied) return denied;
    return tracker.status();
  })

  .post("/address", async ({ headers, set }) => {
    const denied = guard("invoice")({ headers, set }); if (denied) return denied;
    return passthrough(await bark("/api/v1/wallet/addresses/next", { method: "POST" }));
  })

  // A unified payment URI (BIP-321) carrying every rail this wallet can
  // receive on. LNURL cannot express this: none of the 22 published LUDs has a
  // field for an alternative rail, so a Lightning address can only ever hand
  // back a bolt11 — and paying this wallet over Lightning costs the Ark
  // server's flat 20 sat minimum even when both ends sit on the same server.
  // A sender that understands BIP-321 picks the Ark rail and pays nothing.
  .post("/bip321", async ({ headers, set, body }) => {
    const denied = guard("invoice")({ headers, set }); if (denied) return denied;
    audit("bip321", { amount_sat: body.amount_sat });
    return passthrough(await bark("/api/v1/wallet/bip321", {
      method: "POST",
      body: JSON.stringify(body),
    }));
  }, {
    body: t.Object({
      amount_sat: t.Optional(t.Integer({ minimum: 1 })),
      onchain: t.Optional(t.Boolean()),
      label: t.Optional(t.String({ maxLength: 200 })),
      message: t.Optional(t.String({ maxLength: 200 })),
    }),
  })

  .post("/invoice", async ({ headers, set, body }) => {
    const denied = guard("invoice")({ headers, set }); if (denied) return denied;
    audit("invoice", { amount_sat: body.amount_sat });
    return passthrough(await bark("/api/v1/lightning/receives/invoice", {
      method: "POST",
      body: JSON.stringify(body),
    }));
  }, {
    body: t.Object({
      amount_sat: t.Integer({ minimum: 1 }),
      description: t.Optional(t.String({ maxLength: 200 })),
    }),
  })

  .post("/send", async ({ headers, set, body }) => {
    const denied = guard("spend")({ headers, set }); if (denied) return denied;

    // Charge the quota before the await: two concurrent sends must not both
    // see a stale tally and both pass.
    const reason = tracker.reserve(body.amount_sat, body.destination);
    if (reason) {
      audit("send_refused", { reason, amount_sat: body.amount_sat });
      set.status = 403;
      return { message: reason };
    }

    let res: Response;
    try {
      res = await bark("/api/v1/wallet/send", {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (e) {
      // The request may or may not have reached barkd, so the sats may or may
      // not have moved. Keep the reservation: over-counting the day's spend is
      // recoverable, under-counting is not.
      audit("send_indeterminate", { amount_sat: body.amount_sat, error: String(e) });
      set.status = 504;
      return { message: "payment status unknown; quota was charged" };
    }

    if (res.ok) {
      tracker.commit(body.amount_sat);
      audit("sent", { amount_sat: body.amount_sat, destination: body.destination });
    } else {
      // barkd refused it outright, so nothing left the wallet.
      tracker.release(body.amount_sat);
      audit("send_failed", { status: res.status, amount_sat: body.amount_sat });
    }
    return passthrough(res);
  }, {
    body: t.Object({
      destination: t.String({ minLength: 1, maxLength: 2000 }),
      amount_sat: t.Integer({ minimum: 1 }),
      comment: t.Optional(t.String({ maxLength: 280 })),
    }),
  })

  .post("/refresh", async ({ headers, set }) => {
    const denied = guard("spend")({ headers, set }); if (denied) return denied;
    audit("refresh");
    return passthrough(await bark("/api/v1/wallet/refresh/all", { method: "POST" }));
  })

  .listen({ hostname: "0.0.0.0", port: PORT });

// The keeper lives in this process rather than a shell loop calling
// `bark maintain`: the CLI cannot open the datadir while barkd holds it.
// setInterval clamps anything outside [1, 2^31-1] to 1ms, so an unparseable
// value here would turn the keeper into a millisecond loop against barkd and
// Esplora. intFromEnv refuses it at startup instead.
const KEEPER_INTERVAL_MS = intFromEnv("MAINTAIN_INTERVAL", 21_600, { min: 60 }) * 1000;
const keeperDeps = {
  bark,
  esploraUrl: process.env.ESPLORA ?? "https://mempool.second.tech/api",
  thresholdBlocks: intFromEnv("REFRESH_THRESHOLD_BLOCKS", 144, { min: 1 }),
  log: audit,
};

let keeperRunning = false;
const keep = async () => {
  // A slow upstream must not let runs pile up on top of each other.
  if (keeperRunning) {
    audit("keeper_skipped_still_running");
    return;
  }
  keeperRunning = true;
  try {
    await runKeeperOnce(keeperDeps);
  } catch (e) {
    audit("keeper_error", { error: String(e) });
  } finally {
    keeperRunning = false;
  }
};
setTimeout(keep, 30_000);           // once shortly after boot
setInterval(keep, KEEPER_INTERVAL_MS);

try {
  const info = await bark("/api/v1/wallet/ark-info");
  if (info.ok) {
    const { server_pubkey } = (await info.json()) as { server_pubkey?: string };
    ARK_SERVER_PUBKEY = server_pubkey ?? null;
  }
} catch {
  // Without it the Ark hint is simply never offered; Lightning still works.
}

audit("gateway_started", {
  port: PORT,
  barkd: BARKD,
  scopes_configured: (Object.keys(KEYS) as Scope[]).filter((s) => KEYS[s]),
  limits: tracker.status(),
  lightning_address: lightningAddress(LNURL),
  ark_server_pubkey: ARK_SERVER_PUBKEY,
  keeper_interval_s: KEEPER_INTERVAL_MS / 1000,
  refresh_threshold_blocks: keeperDeps.thresholdBlocks,
});
