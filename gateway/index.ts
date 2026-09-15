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
import { timingSafeEqual } from "node:crypto";

import { SpendTracker, scopeAllows, type Scope } from "./policy";
import { RateLimiter } from "./ratelimit";

const BARKD = process.env.BARKD_INTERNAL_URL ?? "http://127.0.0.1:3000";
const BARKD_TOKEN = required("BARKD_AUTH_SECRET");
const PORT = Number(process.env.GATEWAY_PORT ?? 3001);

const KEYS: Record<Scope, string | null> = {
  read: process.env.GATEWAY_READ_KEY || null,
  invoice: process.env.GATEWAY_INVOICE_KEY || null,
  spend: process.env.GATEWAY_SPEND_KEY || null,
};

const tracker = new SpendTracker({
  perTxSat: Number(process.env.SPEND_PER_TX_SAT ?? 10_000),
  perDaySat: Number(process.env.SPEND_PER_DAY_SAT ?? 50_000),
  allowedDestinations: (process.env.SPEND_ALLOWED_DESTINATIONS ?? "")
    .split(",").map((d) => d.trim()).filter(Boolean),
});

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

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Returns the highest scope the presented key grants, or null. */
function scopeFor(authorization: string | undefined): Scope | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const presented = authorization.slice("Bearer ".length);
  let found: Scope | null = null;
  // Check every key regardless of an early match so the work is uniform.
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
    // Behind Caddy, the socket address is the proxy, so prefer its header.
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? server?.requestIP(request)?.address
      ?? "unknown";
    if (!limiter.allow(ip)) {
      audit("rate_limited", { ip });
      set.status = 429;
      return { message: "too many requests" };
    }
  })
  .get("/ping", () => "pong")

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

    const reason = tracker.check(body.amount_sat, body.destination);
    if (reason) {
      audit("send_refused", { reason, amount_sat: body.amount_sat });
      set.status = 403;
      return { message: reason };
    }

    const res = await bark("/api/v1/wallet/send", {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Only count sats that actually left; a rejected payment must not eat quota.
    if (res.ok) {
      tracker.record(body.amount_sat);
      audit("sent", { amount_sat: body.amount_sat, destination: body.destination });
    } else {
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

audit("gateway_started", {
  port: PORT,
  barkd: BARKD,
  scopes_configured: (Object.keys(KEYS) as Scope[]).filter((s) => KEYS[s]),
  limits: tracker.status(),
});
