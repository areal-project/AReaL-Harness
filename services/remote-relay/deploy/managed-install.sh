#!/usr/bin/env bash
set -euo pipefail
umask 077
op=${1:?} owner=${2:?} version=${3:--} address=${4:--} room=${5:--} erase=${6:-false}
[[ "$owner" =~ ^[a-f0-9]{32}$ ]] || exit 64
[[ "$op" =~ ^(deploy|upgrade|inspect|remove)$ ]] || exit 64
[[ $(id -u) = 0 && $(uname -s) = Linux ]] || exit 65
for cmd in systemctl curl sha256sum tar runuser useradd getent flock; do command -v "$cmd" >/dev/null; done
case $(uname -m) in
  x86_64) arch=x64; sha=074e93576f2b0f0f689d12b5d71314c5cdc384b6efc315e264120f6a9dd348af ;;
  aarch64|arm64) arch=arm64; sha=e82b44212eb10ebf4de9bd945b2fcf950786117f6578581bcde0abf4d471af4a ;;
  *) echo UNSUPPORTED_ARCH >&2; exit 65 ;;
esac
[[ -d /run/systemd/system ]] || { echo SYSTEMD_REQUIRED >&2; exit 65; }
base=/opt/areal-relay
data=/var/lib/areal-relay
unit=/etc/systemd/system/areal-relay.service
command -v flock >/dev/null
exec 9>/run/lock/areal-relay.lock
flock -n 9 || { echo DEPLOYMENT_BUSY >&2; exit 67; }
check_owner() {
  [[ ! -e "$1" ]] || { [[ -f "$1/owner" && $(cat "$1/owner") = "$owner" && $(stat -c %u "$1/owner") = 0 ]] || { echo OWNER_MISMATCH >&2; exit 66; }; }
}
check_owner "$base"
check_owner "$data"
[[ -e "$base" || ! -e "$unit" ]] || { echo OWNER_MISMATCH >&2; exit 66; }
if [[ -e "$unit" ]]; then
  [[ $(stat -c %u "$unit") = 0 ]] && grep -Fxq "# AReaL owner $owner" "$unit" || { echo OWNER_MISMATCH >&2; exit 66; }
fi
if [[ "$op" = inspect ]]; then
  if [[ ! -e "$base" ]]; then
    retained=false; absent=true
    if [[ -e "$data" ]]; then retained=true; absent=false; fi
    printf '{"ownerId":"%s","installed":false,"active":false,"dataRetained":%s,"absent":%s}\n' "$owner" "$retained" "$absent"
    exit
  fi
  active=false
  systemctl is-active --quiet areal-relay.service && active=true
  current=$(cat "$base/version" 2>/dev/null || true)
  [[ -z "$current" || "$current" =~ ^[a-f0-9]{64}$ ]] || exit 66
  if [[ -x "$base/node/bin/node" && -e "$data/config.json" ]]; then
    runuser -u areal-relay -- "$base/node/bin/node" --input-type=module - "$owner" "$current" "$active" "$room" <<'JS'
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [ownerId, version, active, room] = process.argv.slice(2);
const config = JSON.parse(readFileSync('/var/lib/areal-relay/config.json', 'utf8'));
let row;
if (existsSync('/var/lib/areal-relay/state/relay.sqlite')) {
  const db = new DatabaseSync('/var/lib/areal-relay/state/relay.sqlite', { readOnly: true });
  try { row = db.prepare('SELECT room,active FROM rooms WHERE room=?').get(room); } finally { db.close(); }
}
console.log(JSON.stringify({ownerId, installed:true, active:active==='true', ...(version ? {version} : {}),
  address:config.publicOrigin, ...(row ? {room:row.room} : {}), roomActive:row?.active === 1}));
JS
  else
    printf '{"ownerId":"%s","installed":true,"active":%s}\n' "$owner" "$active"
  fi
  exit
fi
check_owner "$base"
check_owner "$data"
if [[ "$op" = remove ]]; then
  [[ "$erase" = true || "$erase" = false ]] || exit 64
  if [[ -e "$base" ]]; then
    if [[ -e "$unit" ]]; then
      systemctl stop areal-relay.service
      systemctl disable areal-relay.service
      rm -f "$unit"
      systemctl daemon-reload
    fi
    rm -rf -- "$base"
  fi
  if [[ "$erase" = true && -e "$data" ]]; then rm -rf -- "$data"; fi
  retained=false
  [[ ! -e "$data" ]] || retained=true
  absent=true
  [[ "$retained" = false ]] || absent=false
  printf '{"ownerId":"%s","installed":false,"active":false,"dataRetained":%s,"absent":%s}\n' "$owner" "$retained" "$absent"
  exit
fi
[[ "$version" =~ ^[a-f0-9]{64}$ && "$room" =~ ^[a-f0-9]{64}$ ]] || exit 64
[[ "$address" =~ ^https://[a-zA-Z0-9.:-]+$ ]] || exit 64
stage=$(mktemp -d /opt/areal-relay-stage.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
cat > "$stage/bundle.tar"
printf '%s  %s\n' "$version" "$stage/bundle.tar" | sha256sum -c - >/dev/null
mkdir "$stage/app"
tar -xf "$stage/bundle.tar" -C "$stage/app" --no-same-owner
[[ -f "$stage/app/src/cli.mjs" && -d "$stage/app/node_modules/ws" && -f "$stage/app/assets/remote.html" ]] || exit 68
if [[ ! -e "$base" ]]; then mkdir -m 755 "$base"; printf '%s' "$owner" > "$base/owner"; fi
if [[ ! -e "$data" ]]; then mkdir -m 755 "$data"; printf '%s' "$owner" > "$data/owner"; fi
if [[ ! -x "$base/node/bin/node" ]]; then
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v24.2.0/node-v24.2.0-linux-$arch.tar.gz" -o "$stage/node.tar.gz"
  printf '%s  %s\n' "$sha" "$stage/node.tar.gz" | sha256sum -c - >/dev/null
  mkdir "$stage/node"
  tar -xzf "$stage/node.tar.gz" --strip-components=1 -C "$stage/node" --no-same-owner
  chmod -R a+rX "$stage/node"
  mv "$stage/node" "$base/node"
fi
[[ $("$base/node/bin/node" --version) = v24.2.0 ]] || exit 68
getent passwd areal-relay >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin areal-relay
mkdir -p "$data/state" "$base/versions"
chmod 755 "$base/versions"
chown areal-relay:areal-relay "$data/state"
chmod 700 "$data/state"
if [[ ! -e "$base/versions/$version" ]]; then
  chmod -R a+rX "$stage/app"
  mv "$stage/app" "$base/versions/$version"
fi
"$base/node/bin/node" --input-type=module - "$address" "$base/versions/$version/assets" > "$stage/config.json" <<'JS'
const [publicOrigin, assetsDir] = process.argv.slice(2);
console.log(JSON.stringify({publicOrigin, assetsDir, listen:'127.0.0.1:18443', trustedLocalTlsProxy:true,
  dataDir:'/var/lib/areal-relay/state',allowedClientOrigins:[publicOrigin],allowedAppOrigins:['capacitor://localhost']}));
JS
install -m 640 -o root -g areal-relay "$stage/config.json" "$data/config.json"
runuser -u areal-relay -- "$base/node/bin/node" "$base/versions/$version/src/cli.mjs" provision --config "$data/config.json" --room "$room"
cat > "$stage/service" <<UNIT
# AReaL owner $owner
[Unit]
Description=AReaL managed Remote Relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=areal-relay
Group=areal-relay
ExecStart=$base/node/bin/node $base/versions/$version/src/cli.mjs managed-serve --config $data/config.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data/state
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
UNIT
install -m 644 "$stage/service" "$unit"
systemctl daemon-reload
systemctl enable areal-relay.service >/dev/null
systemctl restart areal-relay.service
printf '%s' "$version" > "$base/version"
curl --fail --silent --show-error --retry 48 --retry-delay 5 --retry-connrefused --max-time 10 "$address/healthz" >/dev/null
systemctl is-active --quiet areal-relay.service
printf '{"ownerId":"%s","installed":true,"version":"%s","active":true,"room":"%s","roomActive":true,"address":"%s"}\n' "$owner" "$version" "$room" "$address"
