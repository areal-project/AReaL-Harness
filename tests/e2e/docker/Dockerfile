ARG BASE_IMAGE=alpine:3.22.4
ARG RUST_IMAGE=rust:1.94-alpine
ARG BUILD_PROFILE=release

FROM ${RUST_IMAGE} AS runtime-builder

ARG BUILD_PROFILE

RUN apk add --no-cache git build-base cmake python3 curl
WORKDIR /src
COPY upstream/pins.json ./upstream/pins.json
COPY Cargo.toml Cargo.lock ./
COPY core ./core
COPY clients/cli ./clients/cli
COPY clients/tui ./clients/tui
COPY clients/web ./clients/web
COPY runtime ./runtime
COPY scripts/launch.py ./scripts/launch.py
COPY scripts/install.py ./scripts/install.py
RUN cargo build --locked --profile "${BUILD_PROFILE}" -p areal-runtime -p areal-runtime-fs -p areal-runtime-exec-native -p areal-cli

FROM runtime-builder AS runtime-tests

RUN apk add --no-cache bubblewrap python3 coreutils
RUN cargo test --locked --profile ci -p areal-runtime-exec-native --no-run
CMD ["cargo", "test", "--offline", "--locked", "--profile", "ci", "-p", "areal-runtime-exec-native"]

FROM ${BASE_IMAGE}

ARG BUILD_PROFILE
ARG CODEX_VERSION=0.145.0
ARG INSTALL_CODEX=1
ARG CLAUDE_CODE_VERSION=2.1.273
ARG INSTALL_CLAUDE_CODE=1
ARG INSTALL_DSH=0
ARG DSH_VERSION=0.1.2-alpha.5
ARG DSH_NODE_VERSION=22.23.2
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG CLAUDE_CODE_NPM_REGISTRY=https://registry.npmjs.org

USER root
ENV PATH="/opt/areal-node/node_modules/node/bin:/opt/areal-perf-tools/bin:${PATH}"

RUN if command -v apt-get >/dev/null; then \
      apt-get update \
      && apt-get install -y --no-install-recommends bash ca-certificates git nodejs npm python3 zstd bubblewrap \
      && rm -rf /var/lib/apt/lists/*; \
    elif command -v apk >/dev/null; then \
      apk add --no-cache bash ca-certificates git nodejs npm python3 zstd bubblewrap; \
    elif command -v dnf >/dev/null; then \
      dnf install -y bash python3.11 git zstd bubblewrap \
      && dnf clean all \
      && command -v node && command -v npm; \
    else \
      echo "unsupported base image: apt-get, apk or dnf is required" >&2; exit 1; \
    fi

RUN if [ "${INSTALL_CODEX}" = "1" ]; then \
      npm config set registry "${NPM_REGISTRY}" \
      && npm install --global --prefix /opt/areal-perf-tools "@openai/codex@${CODEX_VERSION}" \
      && npm cache clean --force \
      && codex --version; \
    fi

RUN if [ "${INSTALL_CLAUDE_CODE}" = "1" ]; then \
      npm install --global --prefix /opt/areal-perf-tools --registry "${CLAUDE_CODE_NPM_REGISTRY}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      && npm cache clean --force \
      && claude --version \
      && test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)"; \
    fi

COPY --from=runtime-builder /src/target/${BUILD_PROFILE}/areal-runtime /usr/local/libexec/areal/areal-runtime
COPY --from=runtime-builder /src/target/${BUILD_PROFILE}/areal-runtime-fs /usr/local/libexec/areal/areal-runtime-fs
COPY --from=runtime-builder /src/target/${BUILD_PROFILE}/areal-runtime-reaper /usr/local/libexec/areal/areal-runtime-reaper
COPY --from=runtime-builder /src/target/${BUILD_PROFILE}/areal /usr/local/bin/areal
COPY tests/perf/runner /opt/areal-perf
COPY tests/perf/trace_metrics.py /opt/areal-perf/trace_metrics.py
COPY scripts/launch.py /opt/areal-launch/launch.py

RUN if [ "${INSTALL_DSH}" = "1" ]; then \
      if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then \
        npm install --prefix /opt/areal-node --registry "${NPM_REGISTRY}" "node@${DSH_NODE_VERSION}"; \
      fi \
      && node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' \
      && npm install --prefix /opt/areal-dsh --registry "${NPM_REGISTRY}" "@deepseek-ai/dsh@${DSH_VERSION}" \
      && mkdir -p /opt/areal-perf-tools/bin \
      && ln -s /opt/areal-dsh/node_modules/.bin/dsh /opt/areal-perf-tools/bin/dsh \
      && dsh --version; \
    fi

ARG PERF_SOURCE_SHA256=unknown
LABEL org.opencontainers.image.title="AReaL-Harness local performance runner" \
      org.opencontainers.image.source="https://github.com/areal-project/AReaL-Harness" \
      org.opencontainers.image.version="${CODEX_VERSION}" \
      io.areal.perf.codex-installed="${INSTALL_CODEX}" \
      io.areal.perf.claudecode-installed="${INSTALL_CLAUDE_CODE}" \
      io.areal.perf.claudecode-version="${CLAUDE_CODE_VERSION}" \
      io.areal.perf.dsh-installed="${INSTALL_DSH}" \
      io.areal.perf.dsh-version="${DSH_VERSION}" \
      io.areal.perf.build-profile="${BUILD_PROFILE}" \
      io.areal.perf.source-sha256="${PERF_SOURCE_SHA256}"

ENTRYPOINT ["python3", "/opt/areal-perf/agent_entrypoint.py"]
