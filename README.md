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

The 6 hour interval is not arbitrary. `bark` refreshes a VTXO once it is within
`vtxo_refresh_expiry_threshold` of expiring — 144 blocks, about 24 hours, on
mainnet. So every VTXO gets four attempts inside its refresh window, which
matters because a refresh is not local: it joins an Ark round, and rounds run
hourly. A keeper that woke only once a day would get one shot at one round.

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
| `Dockerfile.build` | fetches upstream's `bark` + `barkd` 0.7.1 binaries, checksum-verified |
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
| `BARKD_AUTH_SECRET` | *(none)* | 32-byte hex; fixes the bearer token. **Runtime only** — see below |
| `BARKD_EXPOSE_MNEMONIC` | unset | leave unset — enabling it serves the seed over HTTP |

`BARKD_AUTH_SECRET` is worth understanding. Without it barkd generates a random
token on first boot, which then has to be fished out of the container with
`docker exec`. With it, the token is decided before the container exists, so it
can be generated locally, kept in the Keychain and handed to Coolify as a secret
env var — no shell on the host needed to use the wallet.

It is not extra protection. Anyone who can read Coolify's environment can spend
the wallet, and so can anyone with `docker exec` on the host; this only removes
a step, it does not add a boundary.

Mark it runtime-only in Coolify. By default Coolify also hands variables to the
build as `ARG`s, which writes the value in plain text into the build log and,
when a build fails, into the `failed_jobs` table of Coolify's own database. A
secret that has ever been a build argument should be rotated, not re-used.

## The host is ARM

The deployment target is an `aarch64` Hetzner box. A single-platform amd64 image
fails at deploy time with `no match for platform in manifest: not found`, which
surfaces as a deployment that dies in seconds with no logs in the API. CI builds
`linux/amd64,linux/arm64` for that reason.

## First run

```sh
./wallet.sh balance
./wallet.sh address        # fund this over Ark; instant and free
```

## The token

There is only one credential to keep, the 32-byte hex in `BARKD_AUTH_SECRET`:

```sh
security add-generic-password -a "$USER" -s barkd-auth-secret -w
```

The bearer token the API expects is `base64url(0x00 || secret)` — urlsafe, so it
can contain `-` and `_`. `wallet.sh` derives it rather than storing a second
copy, which is why no step here ever needs a shell on the host.

(Worth a warning: a test secret of one repeated byte encodes identically under
both base64 alphabets, so it will not tell you which one is in use.)

Rotating means generating new hex, updating the Keychain and the Coolify
variable, and redeploying. It locks out anything holding the old token, which is
the only revocation mechanism that exists.

## Nothing here compiles

Upstream ships release binaries for both architectures with a `SHA256SUMS` file,
so the image just downloads and verifies them. Two earlier approaches were worse:

- **compiling on the VPS** — a Rust build of this size wants several GB of RAM,
  the 3.7 GB host had none to spare, and Coolify's own containers were starved
  until the panel went unreachable while the already-running sites kept serving.
- **cross-compiling in CI under QEMU** — safe for the server, but tens of minutes
  per build for an artifact upstream already publishes.

Using the release binaries also removes the `You're running a custom build of
bark, which might cause unexpected issues` warning that a cargo build carries,
and shortens the trust chain to upstream's own checksums.

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
