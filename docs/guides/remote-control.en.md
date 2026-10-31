[中文](remote-control.md) | **English**

# Remote Control configuration and deployment

This guide covers implemented local Direct configuration and Relay Host/PWA integration; optional Funnel has a local configuration implementation, with public capability uncertified. Real-phone, Tailscale-network and organization-proxy acceptance is separate from local source and protocol fixtures.

## Local network pairing and Relay Service

In **Settings → Phone connection**, start the local relay. The app selects a private address and an available port and shows a pairing QR code for the mobile app. The phone and computer do not need the same Wi-Fi or subnet. A corporate VPN works when it permits access to the IP address and port in the code. Computer firewalls, VPN access rules, and guest network isolation can still block the connection.

Local codes contain a private HTTP origin and `local=1`. The native mobile app uses a restricted local WebSocket transport. Host pins, Noise encryption, one-use invitations, desktop fingerprint confirmation, and project grants still apply. The app does not load the HTTP page as trusted client code. A mobile browser cannot replace this native path. Host credentials reach the local relay only over loopback, and the LAN interface does not consume enrollment codes.

Running a relay on a computer does not create a public route to it. A home router or carrier NAT can prevent access from cellular networks. AReaL includes no default public connection service or official address. For access across networks, use a reachable self-hosted relay or enter an external HTTPS origin and an administrator one-use enrollment code. You can switch between saved services. Switching retains desktop device grants, but phones need the connection link for the selected service.

**Deploy to Linux server** uses system SSH configuration and ssh-agent. The server host key must already be trusted. Authentication must be noninteractive, and the account needs root or passwordless sudo. Enter `user@host`, the SSH port, and the server HTTPS origin. The domain or public IP and ports 80 and 443 must be reachable from outside. The installer does not edit existing firewalls or reverse proxies. It verifies the Node runtime version and SHA-256, runs the relay with systemd, and obtains and renews certificates through ACME. Upgrades retain data, certificates, and registrations. Removal retains data unless you explicitly select deletion.

An interrupted SSH operation can have an unknown result. Inspect the server before deciding whether to retry. A disconnect does not mean deployment failed or removal finished. Public CA issuance, actual Linux servers, device scanning, and VPN reachability require their own acceptance evidence.

## Currently available scope

Direct provides a default-disabled dedicated loopback entry with local pairing confirmation. Install and build with the [GUI guide](../../clients/gui/README.en.md). In desktop Settings → Mobile connection, enable the local entry, then follow Choose connection method → Open pairing link → Confirm device. Select Generate pairing link. Copy the link into a browser on this computer, or paste it on the Remote page. The invitation lasts two minutes. The page verifies the Host before requesting pairing. Return to the desktop, compare the full device fingerprint, explicitly select existing projects and View only (Observer) or Can operate (Operator), and confirm. The browser can read Host/project lists and work/attention summaries only after the grant is saved. The selected online project refreshes every five seconds while the page is visible; incomplete loaded counts are labelled. Open a session for live detail and use Earlier history to read bounded pages, one window at a time. Large bodies show a preview and a desktop-viewing notice; unavailable upstream history is explicit. Closing detail does not stop work. Refresh session reads current state and ownership again. Disconnect clears old content; reconnecting with Connect computer reads the selected session again. After a Core restart, Refresh session gets a new baseline. Available actions depend on device grants and the implemented API scope linked below.

Authorized devices → Manage permissions changes projects/presets or revokes access. Successful saves close old connections immediately; reconnecting uses the new scope. See the [implemented API scope](../api/remote-control.en.md) for capabilities and submission limits. Browser identity defaults to session-only use. Select Remember this device before pairing to restore identity and Host pin on same-origin reload after a successful save. Browser storage is not a system keychain; shared devices should not opt in. Legacy devices retain project selections but require review, without restoring the old write protocol. Unavailable secure storage rejects enable. Loopback links cannot be opened from another phone. Expand Phone access and network settings to configure persistent Serve HTTPS forwarding; organization HTTPS mode only saves the application origin. Real-device and actual network deployment still require separate validation.

See the [test plan](../development/remote-control-testing.en.md) for commands and evidence boundaries. Local Serve/organization-origin configuration does not prove phone reachability; local Relay strict-TLS tests do not establish public deployment acceptance; public Funnel capability remains uncertified. Never substitute Core or privileged desktop management ports.

Before connection, the web page explains how to open the desktop pairing link; after requesting access it shows Return to your computer to confirm and the complete device fingerprint. Once connected, it shows projects, work and conversations with connection settings collapsed. Conversation and operation details remain available for inspecting original identities and receipts; Connected and Accepted do not mean execution is complete.

### Remembered devices, drafts and offline pages

Restore drafts in this tab is a separate, default-off choice. It restores text after a reload in the current tab; reconnecting never sends it. Remembered devices save original command locators before dispatch. Reload shows unresolved operations and only queries their original results, without resubmission. Unknown, pending and notFound do not prove non-execution; Desktop remains available for checking.

Forget this browser device stops connections and deletes this origin’s identity, Host pin, unresolved locators and this tab’s drafts. If clearing fails, use the browser’s site-data controls. Other open pages stop using the old identity. Revoke Host access separately on Desktop. Changing Host or origin requires new pairing without automatic private-key migration.

Transient failures reconnect with backoff, paused while hidden/offline. Foreground recovery establishes a fresh baseline rather than restoring old subscription cursors. The static shell can open offline but does not claim a Host connection. When an update is ready, finish your operation and close all pages on this site before reopening; updates never refresh a submission midway. GUI quit leaves the existing background Host/Core running. Explicit background-service stop makes entry unavailable, and the page cannot start or repair Core. Direct saves its dedicated loopback port, binds the same port after restart and reconciles mappings before advertising HTTPS. A collision does not select another port to take over the mapping. A stable port does not establish mobile installation or background-running acceptance.

### Review the original Turn

Devices with review capability can select Review original Turn results and changes inside a Session. The page pins that original Turn; long results require additional reads, and failed/interrupted status remains alongside partial text. Read TaskRun status separately rather than inferring it from Turn completion. Historical diffs contain only verifiable Runtime text writes. Missing versions, shell/rename/deletion/binary changes explicitly remain unavailable; the current working tree never replaces them.

Supported original Turn/Item images load only after an explicit click. Each image is limited to 16 MiB plus dimension and decoded-pixel budgets; view animations and other media on Desktop. Reading images can be slow because the current native interface reads the complete original blob again for each Remote chunk. Closing review or the Session, switching images, disconnecting, or changing authorization/service clears content and temporary images. Review does not modify files, execute content or approve tool operations.

## G1. Choose a route

| Concern | Direct: no self-built AReaL backend | Relay: self-hosted/organization backend |
|---|---|---|
| Build scope | Dedicated Host ingress, PWA, wizard, pairing/protocol | The same components plus Relay enrollment/routing/operations |
| Infrastructure | Existing HTTPS/VPN; Serve preferred, Funnel optional | HTTPS domain and WSS-capable server |
| Host inbound | Loopback only, reached through existing infrastructure | No Host inbound port; outbound 443 |
| Phone prerequisite | Serve requires tailnet access; Funnel supports public browser access | Ordinary browser/PWA without VPN |
| Cloud operations | No AReaL backend; provider/organization network remains | Operator manages Relay, TLS and static client |
| Pairing | Configure network once, then QR and desktop approval | Admin deploys once, import profile, QR and approval |
| Vendor account | None | None; no human account platform in P0 |
| Offline Host | No new state or execution | Same; Relay does not execute |

Direct and Relay share authorization and business protocols. Public distribution may recommend an organization-preset Relay while preserving Direct as a complete alternative. Enabling one route must not create another unapproved public endpoint.

### Routes and acceptance scope

This matrix distinguishes source capabilities, their local validation layers and deployment conditions requiring separate acceptance; it is not a certified-platform list. Direct and Relay use the same Native/Core business protocol and acceptance assertions. Each result must identify its source, binary and selected transport; another route or historical run cannot substitute for it.

| Route | Implemented capability and local validation layer | Separate deployment gates |
|---|---|---|
| Direct loopback | Dedicated listener, encrypted pairing and production PWA; Native/Core and browser behavior are validated separately | Local access only; does not prove phone reachability or installed-package operation |
| Direct Serve / organization HTTPS | Same Direct protocol; CLI fixtures cover Serve configuration lifecycle, while organization mode validates the application origin | Actual tailnet/organization policy, trusted TLS, phone pairing and reachability after revocation |
| Relay | Shared Host acceptor, grants and PWA; local Node strict-TLS/container checks and dual-transport Native business validation are recorded separately | Production-browser strict TLS, public 443, phones, operational capacity and organization deployment |
| Optional Funnel | Public-scope transition with two explicit confirmations; local CLI/configuration fixtures | Public capability is uncertified; actual policy, TLS, phone and revocation checks are required without blocking separate acceptance of other routes |

Local Native, real Electron, system secure storage, signed installed packages and physical-device evidence do not substitute for one another. Without an isolated Relay browser TLS fixture, affected browser cases remain UNRUN. Passing Native subchecks cannot establish a whole-entry or release-matrix pass. See [testing and release gates](../development/remote-control-testing.en.md) for commands, repetition counts and verdict rules.

## G2. Direct implementation and user flow

The Host serves the same-origin PWA and `/remote/socket` from a dedicated `127.0.0.1` listener. The trusted background owner derives the forwarding target from its live server. The UI cannot supply a target port, Core address, desktop management address or executable. The owner keeps using the same system-secure-storage-encrypted `remote.json`, without changing Core configuration.

### Serve: private tailnet ingress

Enable the local entry in Settings → Mobile connection, then inspect network tools. The Host needs an available Tailscale CLI, a supported stable version (currently checked as at least 1.52.0), logged-in state and enabled HTTPS capability. The phone must join the same tailnet with appropriate access. Local inspection does not prove organizational ACLs, phone membership or actual phone reachability.

Choose an unused HTTPS port and generate a Serve proposal. Review the displayed HTTPS origin and persistent forwarding scope, explicitly check consent, then apply. The background owner saves a pending record before invoking the CLI with bounded time/output and an argument array. There is no shell interpolation, automatic installation, configuration reset or Funnel fallback. Existing mappings and unknown configuration are not overwritten. Only after exact mapping verification and a successful save do the connection link and new pairing QR use HTTPS.

The owner saves the mapping and fixed Remote port. Changing origin cancels invitations and closes existing remote connections. Pair again at the new origin; browser private keys are not migrated. Recovery only checks an existing record and never repeats apply. Missing or changed mappings require removing the old record before proposing a new mapping.

Close Remote and remove mapping first persists disabled state and stops the listener, then awaits removal of only an exactly matching owned mapping. Cleanup failures retain a recovery journal and diagnostic while the entry stays closed. Externally changed configuration is not deleted. Remove network configuration retries cleanup. Background-process shutdown synchronously closes ingress and retains the persistent Serve mapping; it starts no asynchronous CLI cleanup during exit. To withdraw forwarding, use Settings to disable first. Restart binds the original port before reconciliation. A collision disables ingress and attempts exact owned-mapping removal; failed cleanup remains diagnostic and does not mean external forwarding has been removed.

### Funnel: explicitly selected public ingress (uncertified)

Private Serve is the default. First create an owned private mapping, then generate a public Funnel proposal in the optional Funnel section. The Host reads existing ownership, the live Remote listener, CLI, login, HTTPS and explicit local Funnel port grants (443, 8443, 10000). Ambiguous multiple grants, unknown capabilities and unsupported ports are rejected; Funnel is never run as a probe or to activate a feature automatically.

Review the exact HTTPS origin and private-to-public change, separately check consent to change scope and confirmation of internet exposure, then confirm the scope change. Missing either confirmation prevents publication. New proposals or configuration changes require fresh confirmation; old proposals cannot be reused. Even at the same origin, old invitations are cancelled and existing connections closed. Authorized devices reconnect under existing grant checks; pairing requires a fresh invitation.

Generate a private-restoration proposal to restore tailnet scope explicitly. Restoration and exact removal do not require retained Funnel grants. A failed final save retains pending. Restart reads whether destination, source, absence or foreign drift is present; explicit local recovery saves the observed result without replaying publication commands. Foreign configuration is never overwritten. To leave public mode and disable Remote, use Close Remote and remove mapping, then inspect cleanup diagnostics.

Public capability is uncertified. CLI/local checks do not prove public-phone pairing, TLS, policy or reachability after shutdown; controlled external acceptance remains necessary. Funnel preserves Host pins, short-lived invitations, desktop approval, device grants and per-operation checks, without exposing Core or management ports.

### Existing organization HTTPS ingress

Enter a canonical HTTPS origin such as `https://remote.example.org`, without a path, trailing slash, credentials, query or fragment. Select private organizational access or possible public access and confirm the application configuration scope. Possible public access requires a second confirmation. This only saves the origin accepted by the application and its pairing link; it does not deploy or validate the organization's reverse proxy, certificate, VPN or ACL.

The proxy must forward only the Remote listener, preserve the exact external Host and support WebSocket upgrade. HTTP Host and WebSocket Origin must match the same configured origin exactly. Loopback has its own exact tuple and cannot be mixed with the external tuple. `Forwarded`, `X-Forwarded-Host` and identity headers do not expand trust. Browsers retain normal certificate validation. A proxy supplying Web code is part of the trusted publication boundary.

### Diagnostics and future modes

Settings distinguishes missing/old CLI, logged-out or administrator-approval state, disabled/unknown HTTPS, port collisions, mapping drift and pending recovery. If a phone cannot connect, check its tailnet membership and organization policy. If the Host is offline, inspect its background service; generate a new invitation after expiry. Never recover by ignoring certificates or forwarding Core.

A Serve failure never switches to Funnel or Relay automatically. Public transitions require a fresh local proposal and two explicit confirmations.

## G3. Relay build/deployment boundary

The deployment contains TLS reverse proxy, static PWA and a single Relay instance, potentially on one server/domain. SQLite persists only Host enrollment and invitation consumption, not conversations, code or model secrets. No Redis, task queue, cluster scheduler or business database is required.

Public routes are `/` for built assets, `/remote/socket` for WebSocket, `/healthz` for nonsensitive health and rate-limited `/enroll` for one-use Host registration. Administrative operations are server-local CLI actions, not a public admin UI. Apply TLS, body limits and redacted logs throughout.

See the [Relay service guide](../../services/remote-relay/README.en.md) for actual configuration, ceilings and pinned Node version. Resource ceilings are not capacity certification. Run `pnpm --dir clients/gui build`, then `pnpm --dir clients/gui export:remote /absolute/new/remote-pwa`. Export validates and copies only the Remote manifest asset closure and refuses an existing directory. Set this directory as `assetsDir`; do not deploy the entire Desktop dist.

Containers run non-root with a read-only root filesystem and one writable data volume, without mounting user projects. Pin images/dependencies, publish SBOM/notices and reproducible build instructions. All source, static assets, configuration examples and required scripts must be public.

For native App access, add `"allowedAppOrigins": ["capacitor://localhost"]` to the Relay JSON configuration. The empty array in the examples, or omitting this field, denies App origins. List only the exact `scheme://host` used by the App, without ports, credentials, paths, queries, fragments, whitespace or percent encoding, and exclude HTTP(S)/WS(S) schemes. Keep Web origins in `allowedClientOrigins`. Both lists apply at WebSocket upgrade and client registration; Clients without Origin remain rejected. Native Apps can forge Origin; Noise pins and Host DeviceGrant still verify Host identity and device permissions.

## G4. Administrator and user flow

The administrator provisions DNS/TLS/storage/proxy once and generates a ten-minute one-use Host enrollment code locally. Deliver endpoint and code using an existing secure organizational channel. Users should not configure databases or routers.

In Mobile Settings, enter the exact HTTPS Relay origin and one-use administrator code, explicitly confirm trust, then enable. Once connected, choose Relay as the pairing transport. Changing origin requires new enrollment. A separate Host capability authenticates Relay connections; the consumed enrollment code is not reused and the capability never enters the phone QR.

Enrollment shows progress and preserves the address, code, and consent on failure for review and retry. After successful enrollment, the page identifies the enrolled relay and explains that the code has been used; the code is not displayed again. The add-device dialog shows a QR code and a copyable link. Local HTTP invitations are labeled for browsers on this computer only; phones need a relay or a configured HTTPS entry.

Desktop HTTPS enrollment and Relay WSS share the Desktop TLS configuration: Node's default public roots are combined with system-trusted CAs while standard chain, validity, and hostname checks remain enabled. Teams use the same GUI installer and provision their own test or production private CA through device trust settings. Publicly trusted server certificates need no additional CA installation. The installer contains no team CA, certificate private key, or enrollment code, and requires no terminal environment variables. The server must present its leaf and required intermediate certificates; sending a root certificate does not establish device trust.

### Install an internal team CA (macOS GUI)

1. The administrator distributes the **public root CA certificate** and its SHA-256 fingerprint through an existing trusted team channel. Run `openssl x509 -in team-root-ca.pem -noout -subject -dates -fingerprint -sha256` to check provenance, fingerprint, and validity. Never distribute the CA private key or install the server leaf certificate as a trust anchor.
2. In Keychain Access, import the root CA into the current user's login keychain. Administrators can deploy it to the System keychain on managed computers. Open the root certificate's Trust section, set “When using this certificate” to “Always Trust”, save, and complete system authorization. Importing without granting trust, host-specific exceptions, and accepting browser warnings do not satisfy this deployment method. Administrators should grant this trust only to organization-approved CAs.
3. Fully quit the GUI and its Desktop background service, then launch the GUI normally from Finder. Node caches CAs; restart after installing, removing, or replacing a root. Enter the relay address and one-time registration code and confirm to enable phone access. `NODE_EXTRA_CA_CERTS` is unnecessary. Existing development usage of that variable remains supported through Node's default CA semantics.
4. Generate a fresh QR code with Add device and pair the phone. An iPhone separately needs a profile containing the same CA and full root trust enabled under Settings → General → About → Certificate Trust Settings. Follow the applicable certificate trust policy when deploying through organization MDM or Apple Configurator. Desktop trust settings do not propagate to phones.

Test certificates follow the same validation rules. The server certificate SAN must contain the accessed hostname, or the corresponding IP SAN when using an IP address. Test roots, intermediates, and server certificates must remain valid throughout the planned deployment. Renewing or replacing a server certificate under the same root requires no GUI update. To rotate a root, deploy the new root to desktops and phones and restart before switching the server; remove the old root and restart again after migration.

This uses Node's combined default/system root rules, not every browser certificate policy: system distrust or revocation settings for a public root from another source do not necessarily override Node's default roots. See [Node CA documentation](https://nodejs.org/api/cli.html#--use-system-ca) and [Apple's certificate trust instructions](https://support.apple.com/en-us/102390). Released installers currently support macOS arm64 only; this section does not claim Windows/Linux package acceptance.

For team delivery, launch the same installer from Finder without CA environment variables and verify trusted team A/B CAs and a public CA: successful enrollment, connected WSS, recovery after restart, and phone pairing with a fresh QR code. Uninstalled CAs, expired certificates, and hostname mismatches must be rejected. Enrollment failures retain the form and display TLS error codes; check system trust, server chain, and validity rather than disabling TLS verification.

The desktop creates a QR invitation containing Host pin and route. The phone generates its device identity; the desktop confirms fingerprint and project scope. Remembered devices reconnect on the same origin. New devices, cleared browser storage and changed origins require pairing again; do not transfer private keys automatically across origins.

Remember this device saves the public room with the verified Host identity, so root-page and installed-PWA launches still select Relay. After same-Host re-enrollment, open the new connection link and complete verification to update the remembered room; unverified or refused links leave it unchanged. Forget removes routing metadata too. If Desktop reports unavailable Relay protocol/budgets, upgrade to a service advertising Host-ready limits, or adjust an unusably low policy and explicitly re-enable. Limits are never automatically relaxed.

No human Relay account is required. One instance is one administrative domain; different organizations use independent instances/credentials. Relay administrators can revoke Host routing, while the Host owner revokes individual phones. These are distinct actions.

## G5. Cost and operations

Direct trades AReaL server operations for network-tool setup, mobile VPN usage and provider reachability. Relay trades DNS/TLS, persistent connections, traffic, updates, abuse controls and monitoring for browser-only mobile access. No unverified pricing or capacity estimate is made.

Monitor connected Hosts/channels, failure categories, handshake latency, backlog, bytes and reconnects. Never log frames, tokens or business content. Back up enrollment metadata; there is no Relay conversation history to restore. Database failure must not enable anonymous enrollment. The supported backup-restore procedure disables all restored Host registrations until administrative re-enrollment/review; stale backups must not automatically reauthorize revoked Hosts.

Updates temporarily stop enrollment and drain/disconnect transports; clients reconnect with existing policy and no queued commands. Rollbacks must respect protocol compatibility, never weaken security. In an incident disable Remote locally, revoke devices/routes and inspect accepted Core work. Disconnection is not cancellation or rollback of prior effects.

### Release and rollback conditions

Before enabling public write control, the release owner must review required Direct/Relay Native business and race checks, security and port-isolation checks, production-browser trusted TLS, actual-network and physical-device results against the same frozen source, then explicitly approve release. Package, third-party license and distribution checks follow the [release process](../development/releasing.en.md). Source, container or protocol-fixture passes cannot override failed or unrun mandatory gates.

Authorization failures, private-port exposure, weakened TLS validation, duplicate command execution or unconfirmed migration/configuration persistence require holding release and closing affected ingress. Revoke devices, routes or owned mappings as described above. Roll back only to a validated version compatible with existing encrypted configuration and protocol, preserving identities, project scope and command journals. Never restore the old write protocol or replay unknown commands. Runtime `UNKNOWN` or service drain refusal retains a failure record for manual inspection; forced exit or process cleanup does not establish settlement. Revalidate the failed boundary and revocation outcome before restoring ingress.

## G6. Simple pairing and support boundaries

Once networking/organizational deployment exists, pairing should require only desktop mode/project selection, one phone QR scan and one desktop confirmation. No long-lived token copying, JSON editing or exposed Core port. VPN/domain prerequisites must be stated before onboarding.

Distinguish expired invitation, offline Host, phone outside the tailnet, invalid TLS, old client and unavailable secure storage. Give specific local recovery steps; never solve them by ignoring certificates, removing authentication or exposing privileged ports.

Initial physical-device acceptance targets macOS Host, iOS Safari and Android Chrome browser/PWA. These targets are not certification claims; only actually validated platform/route combinations may be advertised as certified support. Hidden pages, sleeping systems and closed browsers imply no push or background-execution promise.
