# syntax=docker/dockerfile:1.7
# Build the same upstream Python source on every target architecture. The
# published 0.13.0 gateway images have differed from this tagged source.
ARG GATEWAY_BASE_IMAGE=python:3.12.13-slim
FROM ${GATEWAY_BASE_IMAGE}

# LLM-Rosetta v0.13.0, commit 812f86a88d59bcbc9e72ace6053c8e05d7f37606.
# Python >=3.11 needs no third-party runtime dependencies for its HTTP gateway.
ADD --checksum=sha256:54ea2a5e648823ac33a0f238f0ef72ef6306858cbbe8513122a698a5fef955ad \
    https://codeload.github.com/Oaklight/llm-rosetta/tar.gz/812f86a88d59bcbc9e72ace6053c8e05d7f37606 /tmp/llm-rosetta.tar.gz
RUN mkdir -p /opt/llm-rosetta \
    && tar -xzf /tmp/llm-rosetta.tar.gz --strip-components=1 -C /opt/llm-rosetta \
    && rm /tmp/llm-rosetta.tar.gz
ENV PYTHONPATH=/opt/llm-rosetta/src
WORKDIR /opt/llm-rosetta
LABEL io.areal.perf.gateway-revision="812f86a88d59bcbc9e72ace6053c8e05d7f37606"
ENTRYPOINT ["python3", "-m", "llm_rosetta.gateway"]
CMD ["--config", "/config/config.jsonc", "--host", "0.0.0.0"]
