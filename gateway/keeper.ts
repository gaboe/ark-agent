/**
 * Keeps the wallet's VTXOs from expiring.
 *
 * This cannot be done with `bark maintain`: the CLI takes an exclusive lock on
 * the datadir, and barkd already holds it —
 *
 *     another process is already using datadir /data (holder PID: 147)
 *
 * so every run would fail. The work goes through barkd's own HTTP API instead.
 *
 * It also cannot be `POST /refresh/all`, which refreshes every VTXO regardless
 * of expiry. The server charges 0 ppm to refresh something close to expiring and
 * 2000-5000 ppm for something that still has life in it, so refreshing
 * indiscriminately is a standing fee for no benefit.
 */

export interface Vtxo {
  id: string;
  amount_sat: number;
  expiry_height: number;
  state: { type: string };
}

/**
 * VTXOs close enough to expiry that they should be refreshed now.
 * `bark`'s own default threshold on mainnet is 144 blocks (~24h).
 */
export function vtxosNeedingRefresh(
  vtxos: Vtxo[],
  tipHeight: number,
  thresholdBlocks: number,
): Vtxo[] {
  return vtxos.filter(
    (v) => v.state.type === "spendable" && v.expiry_height - tipHeight <= thresholdBlocks,
  );
}

interface KeeperDeps {
  bark: (path: string, init?: RequestInit) => Promise<Response>;
  esploraUrl: string;
  thresholdBlocks: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export async function runKeeperOnce(deps: KeeperDeps): Promise<void> {
  const { bark, esploraUrl, thresholdBlocks, log } = deps;

  const sync = await bark("/api/v1/wallet/sync", { method: "POST" });
  if (!sync.ok) {
    log("keeper_sync_failed", { status: sync.status });
    return;
  }

  const tipRes = await fetch(`${esploraUrl}/blocks/tip/height`);
  if (!tipRes.ok) {
    log("keeper_tip_failed", { status: tipRes.status });
    return;
  }
  const tip = Number(await tipRes.text());
  if (!Number.isFinite(tip)) {
    log("keeper_tip_unparseable");
    return;
  }

  const vtxoRes = await bark("/api/v1/wallet/vtxos");
  if (!vtxoRes.ok) {
    log("keeper_vtxos_failed", { status: vtxoRes.status });
    return;
  }
  const vtxos = (await vtxoRes.json()) as Vtxo[];
  const due = vtxosNeedingRefresh(vtxos, tip, thresholdBlocks);

  if (due.length === 0) {
    log("keeper_ok", { tip, vtxos: vtxos.length, due: 0 });
    return;
  }

  log("keeper_refreshing", {
    tip,
    due: due.map((v) => ({ id: v.id, blocks_left: v.expiry_height - tip })),
  });

  const res = await bark("/api/v1/wallet/refresh/vtxos", {
    method: "POST",
    body: JSON.stringify({ vtxos: due.map((v) => v.id) }),
  });
  log(res.ok ? "keeper_refresh_submitted" : "keeper_refresh_failed", {
    status: res.status,
    body: res.ok ? undefined : (await res.text()).slice(0, 200),
  });
}
