[中文](THIRD-PARTY.md) | **English**

# Deployment provenance and licenses

| Component | Pinned source | License and retained notice |
|---|---|---|
| AReaL Relay | Source commit used to build; record it with image ID | Apache-2.0, `licenses/AREAL-LICENSE` |
| Cindy ACME, CSR, and certificate management | [Cindy](https://github.com/makecindy/cindy/tree/7d7473c62d17b0a893fa503d8a42e35c34ae02d1), adapted to native JavaScript and cancellable lifecycle | Apache-2.0, `licenses/CINDY-LICENSE` and `licenses/CINDY-NOTICE` |
| Node.js | 24.2.0, [upstream](https://github.com/nodejs/node/tree/v24.2.0) | MIT plus bundled component notices, full upstream `licenses/NODE-LICENSE` |
| ws | 8.21.3, npm tarball and integrity in `../package-lock.json` | MIT, `licenses/WS-LICENSE`; npm also retains `node_modules/ws/LICENSE` |
| NGINX | 1.30.5, [upstream](https://github.com/nginx/nginx/tree/release-1.30.5) | BSD-2-Clause, `licenses/NGINX-LICENSE` |
| NGINX unprivileged image recipes | [588b4cbc88065a313909f47a02510639e01cc508](https://github.com/nginx/docker-nginx-unprivileged/tree/588b4cbc88065a313909f47a02510639e01cc508) | Apache-2.0, `licenses/NGINX-IMAGE-LICENSE` |

Base image index digests, verified against Docker Hub Registry v2 metadata:

- `node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89`
- `nginxinc/nginx-unprivileged:1.30.5-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3`

Registry endpoints are `https://registry-1.docker.io/v2/library/node/manifests/24.2.0-bookworm-slim` and `https://registry-1.docker.io/v2/nginxinc/nginx-unprivileged/manifests/1.30.5-alpine` (public pull bearer authentication required). These are multi-platform index digests; record the selected platform and child digest at actual build/deployment. Tags alone are mutable. A digest is reproducible provenance, not a current vulnerability assessment.

The Node image also contains Debian Bookworm packages and npm; the proxy image contains Alpine packages and bundled NGINX modules. These retain their own licenses, not the Relay license. Keep the base image license files, Debian `/usr/share/doc/*/copyright`, npm bundled notices and Alpine package metadata; consult [Debian copyright information](https://www.debian.org/doc/debian-policy/ch-docs.html#copyright-information), [Alpine package index](https://pkgs.alpinelinux.org/packages) and the [official Node image source](https://github.com/nodejs/docker-node). Before distributing an image, generate a platform-specific SBOM/package inventory and satisfy applicable source/notice obligations. This source attribution inventory is not a platform-specific built-image SBOM.

The Docker context is restricted by the service `.dockerignore`; Dockerfile copies only the lockfile/manifests, five Relay source modules, healthcheck and notices. It does not include GUI/Core, local config, certificates, databases, tests or research archives. Dependency installation is `npm ci --omit=dev --ignore-scripts`. Static assets are exported separately and mounted read-only; retain their provenance, lockfile and licenses in the release package. See [operations](README.en.md) for the build, public artifact boundary and deployment checks.
