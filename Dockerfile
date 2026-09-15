# Build bark + barkd from crates.io so the version is pinned and reproducible.
FROM rust:1.91-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install bark-cli --version 0.7.1 --locked --root /out

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /out/bin/bark /usr/local/bin/bark
COPY --from=builder /out/bin/barkd /usr/local/bin/barkd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENV BARKD_DATADIR=/data \
    BARKD_BIND_HOST=0.0.0.0 \
    BARKD_BIND_PORT=3000
EXPOSE 3000
CMD ["/usr/local/bin/entrypoint.sh"]
