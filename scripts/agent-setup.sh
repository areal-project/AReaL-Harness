#!/usr/bin/env bash
# 云端 Agent 容器的启动脚本：固定工具链、装 Linux 跑真实 Core 需要的系统依赖、预构建 Core 与界面。
# 可重复执行；已满足的步骤直接跳过。结束时写 target/agent-env.json，列出本机具备的测试能力。
#   bash scripts/agent-setup.sh            # 全部步骤
#   AGENT_SETUP_SKIP_BUILD=1 bash ...       # 只装工具链和依赖，不构建
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
node_version="$(tr -d '[:space:]' < .node-version)"
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' clients/gui/package.json)"
log() { printf '[agent-setup] %s\n' "$*"; }

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null; then sudo "$@"; else return 1; fi
}

# 1. 系统依赖。bubblewrap 缺失时 Linux Core 会报“不支持权限模式”，新建对话直接失败。
packages=(bubblewrap xvfb libgtk-3-0 libnss3 libgbm1 cmake)
missing=()
for package in "${packages[@]}"; do
  dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package")
done
if [ "${#missing[@]}" -gt 0 ] && command -v apt-get >/dev/null; then
  log "安装系统依赖：${missing[*]}"
  as_root apt-get install -y "${missing[@]}" >/dev/null 2>&1 ||
    { as_root apt-get update >/dev/null && as_root apt-get install -y "${missing[@]}" >/dev/null; } ||
    log "系统依赖安装失败，依赖它们的测试会按 requires 跳过"
fi

# 2. Node 与 CI 同版本，装到 /opt/node-<版本> 并放到 PATH 最前。
node_dir="/opt/node-$node_version"
if [ "$(node -v 2>/dev/null)" != "v$node_version" ]; then
  if [ ! -x "$node_dir/bin/node" ]; then
    log "安装 Node $node_version"
    archive="node-v$node_version-linux-x64.tar.xz"
    tmp="$(mktemp -d)"
    curl -sSfL "https://nodejs.org/dist/v$node_version/$archive" -o "$tmp/$archive"
    as_root mkdir -p "$node_dir"
    as_root tar -xJf "$tmp/$archive" -C "$node_dir" --strip-components=1
    rm -rf "$tmp"
  fi
  export PATH="$node_dir/bin:$PATH"
  profile=/etc/profile.d/areal-node.sh
  line="export PATH=\"$node_dir/bin:\$PATH\""
  if [ "$(cat "$profile" 2>/dev/null)" != "$line" ]; then
    printf '%s\n' "$line" | as_root tee "$profile" >/dev/null || log "无法写 $profile，请手动把 $node_dir/bin 放到 PATH 最前"
  fi
fi
if [ "$(pnpm -v 2>/dev/null)" != "$pnpm_version" ]; then
  log "安装 pnpm $pnpm_version"
  npm install --global "pnpm@$pnpm_version" >/dev/null
fi

# 3. 语言依赖。
cargo fetch --locked >/dev/null
command -v uv >/dev/null && uv sync --locked --only-group dev >/dev/null
make gui-install >/dev/null
# 网页旅程用 Chromium；下载被网络策略拦下时退回容器自带的浏览器。
if ! pnpm --dir clients/gui/app exec playwright-core install chromium >/dev/null 2>&1; then
  for candidate in "${AREAL_CHROMIUM:-}" /opt/pw-browsers/chromium; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      export AREAL_CHROMIUM="$candidate"
      printf 'export AREAL_CHROMIUM=%q\n' "$candidate" | as_root tee /etc/profile.d/areal-chromium.sh >/dev/null || true
      log "Playwright 浏览器下载失败，改用 $candidate"
      break
    fi
  done
fi

# 4. 预构建：Core/Runtime 与界面产物。测试清单里的 core-binary、gui-build 依赖它们。
if [ "${AGENT_SETUP_SKIP_BUILD:-0}" != 1 ]; then
  log "构建 Core（cargo，首次约 10 分钟）"
  # 与 CI 相同：不带调试信息、不做增量，云端磁盘配额有限。
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 make build >/dev/null
  log "构建界面"
  pnpm --dir clients/gui build >/dev/null
fi

# 5. 记录本机能力，供 make baseline-diff 与测试选择读取。
AREAL_CORE_BIN="${AREAL_CORE_BIN:-$root/target/debug/areal}" \
  node clients/gui/scripts/agent-capabilities.mjs --write "$root/target/agent-env.json"
log "完成：$(node -e 'console.log(require(process.argv[1]).available.join(", "))' "$root/target/agent-env.json")"
