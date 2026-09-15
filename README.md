# payment-agent

A Bitcoin wallet the agent can operate on its own.

Today it speaks one protocol: Ark, via `barkd` (the daemon from Second) behind an
HTTPS endpoint, with a keeper loop that stops the funds from expiring. The name
is deliberately not `ark-agent` — Ark is the current backend, not the point. A
Lightning node, a Cashu wallet or Spark could sit behind the same interface
later, and the callers in `wallet.sh` should not have to care.

## Why a daemon and not the CLI

`bark` keeps its seed in a plaintext file and signs locally, so anything that can
run `bark` can also read the mnemonic. `barkd` puts an HTTP API in front of the
same wallet: the seed stays on the host, and callers get a bearer token instead.
`GET /api/v1/wallet/mnemonic` returns 404 unless the daemon is started with
`--expose-mnemonic`, which this deployment does not do.

That is a real boundary, but note what it is not: the token grants **full
spending access**. It is a wallet, not an allowance.

## Why the keeper loop

Ark VTXOs expire. When one does, the funds go to the Ark server — no theft, just
the contract ending. Refreshing is what keeps them alive, and the server charges
0 ppm to refresh a VTXO that is close to expiry (2000–5000 ppm if it still has
plenty of life, which prices pointless churn).

The phone wallet, Noah, solves this with silent push notifications that wake the
app. A server has no such thing, so `entrypoint.sh` runs `bark maintain` every 6
hours in the same container. If that loop dies, the container exits rather than
leaving a wallet nobody is refreshing.

## Expiry is inherited, not granted

Worth knowing before trusting a balance: an Ark transfer does **not** give the
receiver a fresh lifetime. In `ark-lib`, the off-chain send copies the sender's
value verbatim:

```rust
Vtxo { expiry_height: self.input.expiry_height, .. }
```

So a payment can arrive with hours left on it. `./wallet.sh vtxos` shows
`expiry_height`; compare it against the current block height, never assume the
28-day figure from `ark-info`.

## Layout

| file | what |
|---|---|
| `Dockerfile.build` | builds `bark` + `barkd` 0.7.1 from crates.io — runs in CI only |
| `Dockerfile` | what Coolify deploys: a one-line pull of the CI-built image |
| `.github/workflows/build.yml` | builds and pushes `ghcr.io/gaboe/payment-agent` |
| `entrypoint.sh` | creates the wallet if absent, starts the keeper, runs `barkd` |
| `wallet.sh` | client for the payment API; token from the macOS Keychain |
| `deploy.sh` | tells Coolify to pull the new image, waits for `/ping` |

## Configuration

Set in Coolify, not in the image:

| variable | default | what |
|---|---|---|
| `ARK_SERVER` | `https://ark.second.tech` | Ark server |
| `ESPLORA` | `https://mempool.second.tech/api` | chain data |
| `MAINTAIN_INTERVAL` | `21600` | seconds between refresh runs |
| `BARKD_AUTH_SECRET` | *(none)* | 32-byte hex; fixes the bearer token |
| `BARKD_EXPOSE_MNEMONIC` | unset | leave unset — enabling it serves the seed over HTTP |

`BARKD_AUTH_SECRET` is worth understanding. Without it barkd generates a random
token on first boot, which then has to be fished out of the container with
`docker exec`. With it, the token is decided before the container exists, so it
can be generated locally, kept in the Keychain and handed to Coolify as a secret
env var — no shell on the host needed to use the wallet.

It is not extra protection. Anyone who can read Coolify's environment can spend
the wallet, and so can anyone with `docker exec` on the host; this only removes
a step, it does not add a boundary.

## First run

```sh
./wallet.sh balance
./wallet.sh address        # fund this over Ark; instant and free
```

## The token

```sh
security add-generic-password -a "$USER" -s barkd-token -w
```

`barkd secret show` prints it, `barkd secret refresh` rotates it. Rotating it
locks out anything holding the old one, which is the only revocation available.

## Do not build this on the VPS

The first deployment compiled bark on the server. A Rust build of this size
wants several GB of RAM, the host did not have it to spare, and Coolify's own
containers were starved until the whole panel went unreachable — while the
already-running sites kept serving, which made it look like a Coolify fault
rather than a memory one.

The image is now built by GitHub Actions and pushed to GHCR; the server only
pulls it. If you ever edit `Dockerfile.build`, let CI rebuild rather than
pointing Coolify back at it.

## Limits

The seed lives on the VPS. A host compromise is a wallet compromise, and there is
no second factor. Keep the balance at what you would not mind losing.

Unilateral exit — the property that makes Ark trust-minimised — has a floor. A
500 sat VTXO failed to produce a relayable exit chain:

```
Non-Standard VTXO: exit chain is not relayable:
dust sibling output at genesis item 16/18, output 0
```

Eighteen transactions deep, with a dust output no node will relay. Below some
amount you are effectively in custody with the Ark server, able to spend only
while it cooperates. Check `bark exit estimate-fee` for real numbers before
treating a balance as exitable.
