FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libjemalloc2 procps \
  && rm -rf /var/lib/apt/lists/*

# Elastic's production serverless pointer-compressed Node.js v24.22.1 (v8_enable_pointer_compression=1)
RUN mkdir -p /opt/node24-pc \
  && curl -fsSL "https://us-central1-elastic-kibana-184716.cloudfunctions.net/kibana-ci-proxy-cache/node-pointer-compression/dist/v24.22.1/node-v24.22.1-linux-arm64.tar.gz" \
     | tar -xz -C /opt/node24-pc --strip-components=1

ENV PATH="/opt/node24-pc/bin:${PATH}"
ENV JEMALLOC_SO="/usr/lib/aarch64-linux-gnu/libjemalloc.so.2"
WORKDIR /work
