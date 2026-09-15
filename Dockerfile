# Deployed image. The real build lives in Dockerfile.build and runs in CI —
# see .github/workflows/build.yml. Keeping this a pull rather than a compile
# is deliberate: building bark on the VPS exhausted its memory and took
# Coolify down with it.
FROM ghcr.io/gaboe/payment-agent:latest
