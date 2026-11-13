[中文](README.md) | **English**

# AReaL Remote Relay

Single-instance opaque WebSocket routing for `areal.relay.v1`. SQLite stores enrollment hashes, allowed rooms, status, creation time and channel limits. Connections live only in memory; no payload, command queue or conversation database exists. Noise identity pins and device grants remain endpoint responsibilities.

This service's acceptance uses real local HTTP/WebSocket processes and SQLite. It does **not** establish desktop Host/PWA Noise pairing, a real phone, public WSS or cross-network acceptance. Host/PWA source integration and local strict Node TLS cases are covered separately by GUI `test:remote-relay`; browser and phone layers still need independent evidence. See the [API contract](../../docs/api/remote-control.en.md#c12-minimal-relay-service), [guide](../../docs/guides/remote-control.en.md) and [acceptance matrix](../../docs/development/remote-control-testing.en.md).

The [Relay/TLS deployment](deploy/README.en.md) covers nonroot containers, building and mounting Remote-only static artifacts read-only, and operations. Public DNS, trusted certificates, physical devices and capacity still require separate validation in the deployment environment.

## Run locally

From the repository root:

```sh
cd services/remote-relay
npm ci --ignore-scripts
node src/cli.mjs enrollment --config config.development.json
node src/cli.mjs serve --config config.development.json
```

Use **Node 24.2.0** exactly (`.node-version`). The service checks this independently of the GUI runtime. Built-in `node:sqlite` in this version is experimental and prints a warning. The sole package dependency is MIT-licensed `ws` 8.21.3; its public registry URL and integrity are pinned in `package-lock.json`. No install scripts or optional native packages are required.

The internal `src/host-runner.mjs` provides a private process interface for a Host-supervised local Relay: the first stdin line supplies configuration and room, stdout emits ready after listening, and stdin EOF closes the service and store and releases its lock. A GUI bundle can use its controlled headless Electron Node; the ordinary Relay CLI still requires Node 24.2.0 as above. This internal entry does not change the external HTTP/WebSocket protocol.

The local administrator's `enrollment` command prints a random 256-bit, ten-minute, single-use code. Transfer it privately to the Host operator. `POST /enroll` accepts exactly `{"code":"..."}` with `Content-Type: application/json` and **no Origin**; success (201) returns exactly `{"capability":"...","room":"..."}`. The capability is 32 random bytes encoded as unpadded base64url. `room` is lowercase hex SHA-256 of the UTF-8 capability. Store the capability in Host secure storage, never in the browser invitation/QR. Lost responses require a new code; there is no credential recovery API.

`GET /healthz` returns `{"ok":true}`. There is no public administration route. `assetsDir` must explicitly name a built PWA directory containing `remote.html`; `/` serves that file. Omit it for a transport-only service (static requests then return 404). Only files within that directory are served, with CSP, no-referrer, MIME protection and no-store headers. Do not place credentials or private files there.

Build with `pnpm --dir clients/gui build` and export the Remote asset closure using `pnpm --dir clients/gui export:remote /absolute/new/remote-pwa`; use that output as `assetsDir`, never Desktop dist. CSP `style-src` permits inline styles, matching Direct for the same PWA styles; script policy remains same-origin.

Host ready advertises configured frame/byte/max-frame limits, the actual heartbeat interval, and `push:boolean`. An older service without `push` means unsupported. New Hosts require these limits and do not use older services that omit them; Client ready-channel is unchanged. Host reserves heartbeat capacity and paces data/close, refusing unusably low budgets without changing service configuration. The service still enforces its original per-frame limits; the declaration grants no execution authority.

## Production boundary

Copy `config.example.json` and set the exact HTTPS `publicOrigin`, explicit `allowedClientOrigins`, private `dataDir` and built `assetsDir`. Relative paths resolve from the working directory. The backend only binds `127.0.0.1` or `::1`; `trustedLocalTlsProxy: true` explicitly acknowledges a **trusted TLS proxy on that same machine**. Public TLS/WSS termination and proxy deployment belong to RC-14. This service has no direct TLS listener and must never be forwarded as plaintext from a public listener.

Configure that proxy to accept only the chosen HTTPS hostname, preserve its exact Host header, forward `/remote/socket` as WebSocket, and impose request/connection limits. Plain HTTP may redirect to HTTPS but must not proxy enrollment or WebSocket traffic. Do not log request bodies, WebSocket data, enrollment codes, credentials, invites or sensitive URL fragments. Backend checks do not trust `Forwarded` or `X-Forwarded-*`; other local processes are inside this explicit trust boundary. There is no wildcard Origin or automatic public fallback. HTTP/WS are permitted only with explicit `development: true` and loopback public origin.

Relay `allowedClientOrigins` continues to accept Web origins only. Optional `allowedAppOrigins` defaults to `[]`; native App deployments can explicitly set `["capacitor://localhost"]`. Each entry must be an exact `scheme://host` with a scheme other than `http`, `https`, `ws` or `wss`. Empty hosts, credentials, ports, paths (including a trailing slash), queries, fragments, whitespace and percent encoding are rejected. Both WebSocket upgrade and client registration require an Origin that exactly matches either list. Origin-less connections can only register as Hosts with valid enrollment credentials, never as Clients. A custom scheme can have `URL.origin` equal to `null`, so comparison uses the validated complete string. Native Apps can forge Origin; it grants no identity or execution authority. Noise pins still verify Host identity, and Host DeviceGrant still determines permissions.

## Outer wire

Connect to `/remote/socket`; compression and binary WebSocket messages are disabled. Registration is the first JSON message:

| Sender | Message / response |
|---|---|
| Host, no Origin | `{protocol:"areal.relay.v1",role:"host",room,capability}` → `{type:"ready",push?:boolean,limits:{framesPerSecond,bytesPerSecond,maxFrameBytes,heartbeatIntervalMs}}` |
| Client, allowed Origin | `{protocol:"areal.relay.v1",role:"client",room}` → `{type:"ready",channel}`; Host receives `{type:"open",channel}` |
| Either endpoint | `{type:"data",channel,data}` forwards opaque standard padded base64 to the owned peer only |
| Either endpoint | `{type:"close",channel}` releases that channel |
| Relay | `{type:"error",code}` or `{type:"close",channel}`; errors never echo input |

Hosts that support push send the `X-Areal-Relay-Capabilities: push` header during the WebSocket upgrade. Only these Hosts receive the optional `push` field in ready and `pushResult` messages. Legacy Hosts retain the original ready shape. Legacy Relays ignore the header, and a missing ready field means push is unavailable. This header advertises decoder support; the registered capability remains the Host identity proof.

Client data/close **must** carry its ready-provided channel. Valid Host reconnect replaces its old connection and closes all old channels. Stale Host sockets cannot reach new channels. Unauthorized or retired Host channel frames receive uniform `UNAVAILABLE` without routing; this permits in-flight data and Host close echoes without disconnecting other devices. Forged Client frames close that Client. Unknown, disabled and offline rooms all return the same `UNAVAILABLE`. On restart, endpoints reconnect and obtain a new application baseline; no offline messages are retained.

## Configure APNs

Default configurations omit `apns` and Host `ready` returns `push:false`. `config.apns.example.json` shows the configuration required for push. Replace the team ID, key ID, and Bundle ID, and place the Apple P-256 `.p8` key at `keyFile`. Startup reads that file; administration commands only validate configuration. The service process needs read permission. For containers, mount the key separately as a read-only file at the configured path, readable by UID 1000. Keep the key outside images, source control, and data backups.

`maxPerHostPerMinute` defaults to 60 and accepts integers from 1 through 600. The budget belongs to the registered room, so reconnecting a Host does not reset its current-minute budget. At most 32 APNs requests run concurrently, with a 10-second deadline each. Rate limiting returns `LIMIT_EXCEEDED`; disabled push returns `UNAVAILABLE`. The Host connection remains usable. Relay does not retain tokens, queue notifications, or retry. Delivery failure changes no session or approval state.

`production` uses `https://api.push.apple.com`, including TestFlight; `development` uses `https://api.sandbox.push.apple.com`. System TLS verification stays enabled. ES256 JWTs are cached for 50 minutes. Requests carry the configured Bundle ID, `alert` push type, priority 10, and the Host's `collapseId`. Only fixed Chinese alert text enters `aps`; navigation IDs enter top-level `target`. For `410 Unregistered`, Relay sends `pushResult` to the current Host so it can remove the token. Logs contain only time, random route, kind, and status.

See Apple's [token authentication documentation](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns) and [notification request documentation](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## Budgets and administration

Configuration may only lower the ceilings in `src/config.mjs`: 100 active Hosts, 256 total TCP/WS connections, 32 unregistered WS connections, 16 channels/Host, 512 KiB outer JSON, 2 MiB output queue per socket, 80 received frames and 2 MiB per second/socket, 50 upgrades/s and 10 enrollments/s globally. Base64 must fit within `maxFrameBytes - 128`; split larger Noise byte sequences before encoding. A slow Client loses only its channel. Host output is also bounded as one shared socket.

WebSocket parsing permits at most 128 fragments and 128 buffered chunks. Registration has a 15-second deadline; heartbeat is 15 seconds with a 45-second unreachable timeout. HTTP headers have 10 seconds, requests 15 seconds, bodies 1 KiB on enrollment, headers 8 KiB, and a global 200 requests/s ceiling. Rate budgets use one-second windows. These limits apply before Noise; the Relay cannot observe Noise completion or count business reads/writes. The Host must still enforce the 15-second Noise/hello deadline, pending-device limits and application request limits. Ceiling values are resource controls, **not** tested production capacity claims.

The local CLI uses the same config for all commands:

```sh
node src/cli.mjs revoke ROOM --config CONFIG.json
node src/cli.mjs backup /private/backup.sqlite --config CONFIG.json
# Stop serve before restore:
node src/cli.mjs restore /private/backup.sqlite --config CONFIG.json
```

Revoke persists first; forwarding checks registration each frame and an idle Host closes within one second. Revoking a Relay room is distinct from revoking a phone's Host grant. Backup uses SQLite's online backup and refuses an existing destination. Supported restore requires the service stopped and disables **all** restored registrations and enrollment codes before replacement. Before replacement, restore requires a complete SQLite checkpoint of both the disabled staged database and any existing database, with no busy or remaining WAL work. It never manually deletes the live WAL. A failed checkpoint refuses replacement; a failed or interrupted atomic rename leaves the committed old revocations intact. Generate fresh enrollments after successful restore; never copy an old database directly into a live deployment.

Data directory/file permissions are 0700/0600. A `server.lock` prevents two service processes or restore during serving; an `admin.lock` serializes local administration. Clean shutdown releases them. After a crash, verify that the recorded PID and any service/admin process are stopped before removing a stale lock; never remove an active lock. An interrupted restore may also leave `restore.sqlite`, `restore.sqlite-wal` and `restore.sqlite-shm`: after those processes are stopped, remove only these staging files before retrying restore. Do not delete the live `relay.sqlite-wal` or `relay.sqlite-shm`. Normal startup after lock cleanup reads either the intact old committed state or the fully disabled replacement. If the existing database is corrupt or cannot checkpoint, preserve it and restore the trusted backup into a fresh private `dataDir`; do not bypass checkpoint validation. Run one OS service account on a local filesystem; do not share this volume across machines. Enrollment records expire and are pruned at code issuance; the database permits at most 1,024 unexpired codes and 10,000 room records, including revoked records. There is no automatic room deletion or rollback of revocations.

## Acceptance

```sh
npm test
npm audit --omit=dev
```

Tests start isolated real service processes, use actual WebSocket sockets, exercise capability/room/channel forgery, replacement/close races, restart/offline behavior, anonymous capacity/timeouts, frame/byte/fragment limits, a TCP reader that stops consuming, HTTP/Origin/static boundaries, expiration, revoke, backup/disabled restore, and marker scans of logs/SQLite. They test the opaque routing seam, not Noise or GUI behavior. No cloud, phone, public domain, native GUI or production-capacity test runs here.

Push tests generate temporary P-256 keys and TLS certificates and use CLI enrollment, real WebSockets, and local HTTP/2 TLS to verify signatures, caching, fixed payloads, limits, failures, and shutdown. Tests substitute the network connector at an internal constructor boundary and connect only to localhost. Actual APNs delivery, iPhone lockscreen behavior, and TestFlight signing require separate acceptance with actual Apple resources.
