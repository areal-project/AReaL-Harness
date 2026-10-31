[中文](README.md) | **English**

# Relay deployment

This deployment uses nonroot Relay/TLS containers and a separately exported Remote static client. Source configuration does not certify public-network or physical-device acceptance; operators must verify their own TLS, network, device pairing and access boundaries. Never deploy the entire desktop renderer dist as public assets. No production capacity has been measured; configured limits are resource ceilings.

## Manage a server from Desktop

**Settings → Phone connection → Relay Service** can install, upgrade, inspect, and remove a relay over system SSH. Automatic deployment uses Node and systemd. It requires Linux x64 or arm64, root or passwordless sudo, an already trusted SSH host key, and an externally reachable HTTPS address with ports 80 and 443. Docker is not required. Existing manual Compose/nginx deployments use the steps below.

`managed-install.sh` manages `/opt/areal-relay`, `/var/lib/areal-relay`, and `areal-relay.service`. It only manages an instance with the matching owner. It downloads a fixed Node version from the official source and verifies SHA-256. ACME HTTP-01 obtains and renews trusted certificates. The installer does not edit existing firewalls or reverse proxies. If ports are occupied or issuance fails, inspect the existing service state.

Deployment submits only the public room hash. Capability stays in the encrypted Desktop configuration. Inspect after an SSH interruption before deciding whether to retry. Removal retains data by default. The app includes neither a default official address nor public NAT traversal. See the [Remote guide](../../../docs/guides/remote-control.en.md).

## Build the Remote artifact from public source

Run from the root of a clean checkout at the selected revision, using Node.js 24.2.0 and pnpm 11.7.0 pinned by `clients/gui/package.json`. `--ignore-scripts` disables dependency installation scripts; this static build does not invoke the Electron installer, Core or native packaging. Dependencies come from the public registry and are fixed by `clients/gui/pnpm-lock.yaml`. `REMOTE_RELEASE` must be a new directory outside the checkout with an existing parent:

```sh
export REMOTE_RELEASE=/absolute/releases/remote-YOUR_SOURCE_COMMIT
mkdir "$REMOTE_RELEASE"
git rev-parse HEAD > "$REMOTE_RELEASE/source-commit.txt"
pnpm --dir clients/gui install --frozen-lockfile --ignore-scripts
pnpm --dir clients/gui build
pnpm --dir clients/gui run export:remote "$REMOTE_RELEASE/assets"
chmod -R a+rX "$REMOTE_RELEASE/assets"
cp LICENSE "$REMOTE_RELEASE/LICENSE"
cp clients/gui/THIRD-PARTY-NOTICES.md "$REMOTE_RELEASE/THIRD-PARTY-NOTICES.md"
cp clients/gui/renderer/ZCODE-LICENSE "$REMOTE_RELEASE/ZCODE-LICENSE"
cp -R clients/gui/licenses "$REMOTE_RELEASE/licenses"
cp clients/gui/pnpm-lock.yaml "$REMOTE_RELEASE/pnpm-lock.yaml"
export RELAY_ASSETS="$REMOTE_RELEASE/assets"
```

The export CLI reads this build's `remote-assets.json`, verifies each SHA-256 and copies only the `remote.html` closure, manifest and service worker. It refuses an existing output directory or failed verification instead of merging versions. Exported files must be readable by container UID 1000; the permission command above applies only to public assets, never certificates or private data. Mount only `assets` in Relay; keep the source revision, lockfile and licenses beside it in the release package, outside public routes. Do not copy dist from another active checkout or add `index.html`, desktop bundles, configuration or credentials. Keep the exported directory immutable and create a new directory for updates.

Archive the version returned by the export CLI, `remote-assets.json`, Node/pnpm versions, build logs and complete licenses/attribution for included dependencies. The repository notices copied above do not replace license obligations for third-party dependencies included in the browser bundle; retain their original license texts according to the lockfile and actual build inventory before distribution. Record the static package and service image as separate artifacts of the same release.

## Administrator preparation

Use a single Docker Engine host with Compose supporting `network_mode: service:relay`. Supply DNS for one exact hostname, a trusted TLS certificate/full chain and its key. This fragment performs no DNS, ACME, cloud or firewall setup. Only TCP 443 is published; no HTTP listener exists. The two nonroot containers share a network namespace so the backend remains on 127.0.0.1:8080. Do not publish 8080 or attach untrusted containers to that namespace. The TLS container has no database mount.

Copy `relay.example.json` and `nginx.example.conf` outside the checkout. Replace `remote.example.org` consistently in both files, including the exact Host comparison and client Origin. Retain `listen`, `trustedLocalTlsProxy`, `/data`, and disabled payload logging. Configuration uses JSON files, **not Relay environment variables**. Administrators edit deployment JSON; end users receive an endpoint and one-time enrollment code through the Host interface.

Make config files readable by their container users. On a Linux deployment host, provision the TLS key as UID/GID 101:101, mode 0400, with traversable parent directories; never make the key world-readable. Relay is UID/GID 1000:1000. The image seeds `/data` as 1000:1000, mode 0700; a fresh named volume inherits this ownership. Existing volumes must already have that ownership and private permissions. Do not run a root repair container. Use one OS administrator account, a local filesystem and one Relay instance. Do not share the SQLite volume across hosts.

From this directory, set these **Compose interpolation variables** in your shell (or a private Compose env file):

```sh
export RELAY_IMAGE=areal-remote-relay:YOUR_SOURCE_COMMIT
export RELAY_CONFIG=/absolute/private/relay.json
export RELAY_ASSETS=/absolute/releases/remote-YOUR_SOURCE_COMMIT/assets
export NGINX_CONFIG=/absolute/private/nginx.conf
export TLS_CERT=/absolute/private/fullchain.pem
export TLS_KEY=/absolute/private/privkey.pem
docker compose config --quiet
docker compose build relay
docker compose up -d relay
docker compose run --rm --no-deps tls -t
docker compose up -d
```

Never suppress certificate or config failures. `docker compose config` validates Compose shape only. The healthcheck sends `/healthz` with the configured exact Host to loopback; it proves neither TLS nor enrollment. Verify the real certificate from a client, WSS, wrong Host/Origin rejection, plaintext rejection and absence of externally reachable 8080 before exposing this deployment to users. Review the rendered configuration and actual listening ports. Image pins and attribution are in [THIRD-PARTY](THIRD-PARTY.en.md).

Both containers use read-only root filesystems and bounded tmpfs `/tmp`. Node is PID 1 and receives SIGTERM directly; its existing shutdown path releases locks. NGINX has one worker and writes its PID/temp files in `/tmp`. Access logs are disabled and request-bearing NGINX error logs are discarded to avoid secret URLs; use container exit status and private active health checks for diagnosis. This sacrifices proxy error detail. No automatic restart hides stale-lock failures.

## Host enrollment and device pairing

After validating the endpoint, the administrator generates a one-time code with the local CLI below and privately supplies the exact HTTPS origin and code to the Host user. In desktop Settings → Phone connection, enter the Relay origin and code, confirm trust and enable it. The Host stores its capability in secure storage and refuses to enable when secure storage is unavailable. Once connected, select the Relay pairing transport, choose Pair a new phone and scan the link. Return to the desktop to verify the full device fingerprint, existing project scope and Observer/Operator preset before explicitly granting access.

The device authorization section can change scope or revoke a device; the Relay administrator can also disable an entire Host room with `revoke` below. These are separate Host grants and Relay registrations. A new origin requires enrollment and pairing again; browser private keys do not migrate. After a Host/Core restart, clients obtain a fresh baseline and must not automatically replay unknown submissions. Individuals may choose Direct without deploying this service. See the [connection guide](../../../docs/guides/remote-control.en.md) for public controls and recovery behavior. These steps require no vendor account, Core token, product JSON edits by users or public Core port.

## Local administration and private backup

Run commands from this directory with the same Compose variables. Do not record the enrollment command output in shared logs. It expires in ten minutes and is consumed once. Host capability remains in Host secure storage and never goes into a phone invitation. No Core token or public Core port is involved.

```sh
docker compose exec -T relay node src/cli.mjs enrollment --config /config/relay.json
docker compose exec -T relay node src/cli.mjs revoke ROOM --config /config/relay.json
# Choose a new backup filename; existing targets are refused.
docker compose exec -T relay node src/cli.mjs backup /data/backup.sqlite --config /config/relay.json
umask 077
docker compose cp relay:/data/backup.sqlite ./backup.sqlite
chmod 600 ./backup.sqlite
```

Keep the backup outside public assets and source control. Backups contain enrollment/room metadata, not conversation history. Maintain an independent private revocation inventory. Relay room revocation and Host device-grant revocation are separate operations.

For a trusted backup already at `/data/backup.sqlite`, use the supported restore, never a raw overwrite:

```sh
docker compose stop tls relay
docker compose run --rm --no-deps relay restore /data/backup.sqlite --config /config/relay.json
docker compose up -d --force-recreate relay tls
```

To import an external backup while both services are stopped, write it as the Relay user into a new file (existing files are refused):

```sh
docker compose run --rm --no-deps -T --entrypoint node relay -e 'require("node:fs").writeFileSync("/data/import.sqlite",require("node:fs").readFileSync(0),{mode:0o600,flag:"wx"})' < ./backup.sqlite
```

Use `/data/import.sqlite` in the restore command. This keeps ownership 1000:1000. Do not use `down -v`. Restore disables **every** restored Host and enrollment before checkpoint/atomic replacement. Compare the revocation inventory, generate fresh enrollment codes and review grants before routing again. Database errors fail closed; there is no anonymous fallback.

A crash can leave `server.lock` or `admin.lock`. Stop both services and every one-off admin container before inspecting locks. PIDs refer to container namespaces and can be reused; a PID alone is not proof of a live or dead process. After independently proving no service/admin process has the volume open, remove only stale locks and interrupted `restore.sqlite`, `restore.sqlite-wal`, `restore.sqlite-shm` using a nonroot one-off Relay container. Never delete `relay.sqlite-wal` or `relay.sqlite-shm`. See the [service restore rules](../README.en.md). Preserve a damaged volume and restore a trusted backup into a new private volume if checkpoint fails.

## Upgrade, rollback and static assets

Record source commit, built image ID/digest, both base digests, configuration hashes and measured capacity (currently unmeasured). Retain the previous local image. Stop TLS first to block new enrollment and disconnect sockets, make an online backup through Relay, then stop Relay. Set `RELAY_IMAGE` to the new revision, build and recreate **both** containers so TLS joins the new network namespace. Clients reconnect; no queued commands survive. Validate health and real TLS/WSS before distributing enrollment codes.

Rollback to a protocol/schema-compatible retained image with the current database; do not roll the database back just to roll code back. If data restore is necessary, use the disabled restore procedure above and fresh enrollments. Do not downgrade authentication or skip revocation review. Rollback compatibility is not established by this fragment.

Compose requires `RELAY_ASSETS` to point to an exported Remote directory, mounted read-only at Relay `/assets`; the example JSON sets `assetsDir: "/assets"`. Missing directories are not created automatically. TLS has no static-assets or database mount. Switch to the complete compatible static revision together with the service image and recreate both containers; retain matching static artifacts for rollback. Check the versions/hashes of `/`, the manifest, service worker and actual modules, CSP and MIME/no-store/no-referrer headers; confirm desktop entrypoints, management routes, unknown files and traversal requests are denied. Do not loosen CSP or bypass certificate verification to suppress errors.
