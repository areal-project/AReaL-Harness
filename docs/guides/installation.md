**中文** | [English](installation.en.md)

# 安装与升级

安装包发布到 GitHub Release 后，使用本页命令。发布前应在本地构建并验收候选产物，不能把尚未发布的版本或 tap 当作可用安装源。

## 平台与组成

| 平台         | 分发方式                                                               | 前置条件                                                                                       |
| ------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| macOS arm64  | GitHub Release 完整包 + Python 安装器；公开 Homebrew 稳定版与 beta formula | macOS 15+、Xcode Command Line Tools；独立安装/升级需 PATH 中的 Python 3.9+                     |
| Linux x86_64 | GitHub Release 完整包 + Python 安装器；公开 Homebrew 稳定版与 beta formula         | Ubuntu 22.04 或更新的兼容 glibc 2.35+ 系统；独立安装/升级需 PATH 中的 Python 3.9+；不支持 musl |

只验证上述架构，不提供 Windows、macOS Intel 或 Linux arm64 包。**npm 与 `cargo install` 尚未提供完整发行包**，不能作为安装渠道。Homebrew 和独立安装器二选一，不应同时管理同一个 PATH 入口。每个包包含 `bin/areal`、`libexec/areal/{areal-runtime,areal-runtime-fs}`、LICENSE 和文件 SHA256 manifest；Linux 包另外包含同目录的 `areal-runtime-reaper`，不要只复制 `areal`。安装后无需 Rust/Cargo；macOS 仍需要可用的 `/usr/bin/python3`（Command Line Tools），运行自定义 Node/Python 工具需对应解释器。

macOS GUI 在启动新后台前检查开发工具和系统 Python，缺少依赖时显示安装引导。安装完成后点击重新检测。系统解释器仍是运行前提，完整包的 `manifest.json` 声明该依赖。

macOS 包采用 ad-hoc 签名，尚无 Developer ID 签名和公证。Linux 默认 YOLO/full-access 以当前用户权限运行；受限/只读 Scope 需要 `/usr/bin/bwrap` 及可用 user namespace。Ubuntu 可安装 `bubblewrap`；系统禁用 user namespace 或 AppArmor 拒绝时，受限操作会失败，不自动放宽权限。完整边界见 [Runtime 部署](runtime.md)。

## Homebrew（macOS / Linux）

公开 [tap](https://github.com/areal-project/homebrew-tap) 提供 macOS arm64 与 Linux x86_64 的默认稳定版 `areal` 和可选的 `areal-beta`，使用公开 Release 的完整归档及 SHA256 校验和。发布 Beta 只更新 `areal-beta`；默认 `areal` formula 继续跟踪稳定版。

两平台使用相同命令。`areal-beta` 为 keg-only，不替换稳定版 PATH 入口：

```sh
brew tap areal-project/tap
brew install areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
# 可选 Beta：用绝对入口启动，不强制 link
brew install areal-project/tap/areal-beta
brew test areal-project/tap/areal-beta
"$(brew --prefix areal-project/tap/areal-beta)/bin/areal" --version
```

Linux formula 仅支持 x86_64、宿主 glibc ≥ 2.35，需系统安装 `/usr/bin/bwrap`（Ubuntu: `sudo apt-get install bubblewrap`）；Homebrew 自身的系统依赖与支持范围见[官方 Linux 指南](https://docs.brew.sh/Homebrew-on-Linux)。这不新增 Linux arm64 或 musl 支持。 产品完整包与独立安装器保持 glibc 2.35 基线；原生 Linuxbrew 验收使用 Ubuntu 24.04 / glibc 2.39。较旧 glibc 主机上，Homebrew 可能额外安装自身 glibc/GCC；本次验收不证明所有旧系统与自定义 prefix 的组合，必要时使用独立安装器。

后续升级先完成任务并安全停止共享服务（`areal service list`；各工作区用 `areal service stop --workspace /absolute/workspace`，保留原配置参数，不加取消选项），然后：

```sh
brew update
brew upgrade --formula areal-project/tap/areal
brew test areal-project/tap/areal
areal --version
# Beta 仅升级自身
brew upgrade --formula areal-project/tap/areal-beta
brew test areal-project/tap/areal-beta
"$(brew --prefix areal-project/tap/areal-beta)/bin/areal" --version
```

新版 `areal upgrade --check` 只读取本机 tap 中同一 formula 的版本，不刷新 tap；先 `brew update` 可取得新定义。`areal upgrade` 先确认服务全为 Stopped，再更新 tap、升级安装收据所记的实际 formula，并验证入口版本。使用拥有此 Cellar 的 Homebrew，不从 PATH 猜另一个实例；收据缺失、来源不明或频道改变时拒绝操作。稳定安装不会自动进入 beta；beta 不自动转稳定。旧 CLI 内嵌的硬编码升级逻辑不会自动修复，首次过渡使用上述精确 `brew upgrade --formula <实际tap/formula>`。不要用 Python 安装器覆盖 Cellar。Homebrew 可能清理旧 keg，因此此路径仍需先停服；命令不替用户停止或取消任务。

## 独立安装（macOS / Linux）

从同一 Release 下载安装器和清单，校验后执行。固定版本避免在未知版本之间静默升级：

```sh
version=0.1.8
base="https://github.com/areal-project/AReaL-Harness/releases/download/v${version}"
curl -fL "$base/install.py" -o install.py
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
python3 - <<'PY'
import hashlib
from pathlib import Path
lines = [line.split() for line in Path('SHA256SUMS').read_text().splitlines()]
expected = [digest for digest, name in lines if name == 'install.py']
assert len(expected) == 1 and hashlib.sha256(Path('install.py').read_bytes()).hexdigest() == expected[0]
PY
python3 install.py --version "$version"
export PATH="$HOME/.local/bin:$PATH"
command -v areal
areal --version
areal build-info
```

默认安装到 `~/.local/lib/areal/<version>-macos-arm64` 或 `<version>-linux-x86_64`，入口为 `~/.local/bin/areal` 符号链接。`--prefix /absolute/path` 可选择有写权限的其他目录；不会自动 sudo 或修改 shell 配置。指定目录中已有非安装器管理的 `bin/areal` 时拒绝覆盖，同版本目录存在时拒绝覆盖。

离线安装先下载平台 tar.gz 与同一 Release 的 SHA256SUMS：

```sh
python3 install.py --version 0.1.8 --prefix "$HOME/.local" \
  --archive areal-harness-v0.1.8-x86_64-unknown-linux-gnu.tar.gz \
  --checksums SHA256SUMS
```

macOS 离线安装将归档名改为 `areal-harness-v0.1.8-aarch64-apple-darwin.tar.gz`。`python3 install.py --version latest --check` 仅查询最新已公开 Release，不安装；`--version latest` 可在明确选择时安装最新版。

安装器在执行任何包内程序前校验归档和全部文件，拒绝链接、设备和路径逃逸归档。SHA256 校验提供与发布清单的一致性，不替代发布源的身份验证。

## 升级命令

先备份配置与历史（默认 `~/.areal`；自定义数据目录也需备份）。安装器管理的完整包可在后台继续运行时更新入口：

```sh
areal upgrade --check
areal upgrade
command -v areal
areal --version
areal build-info
```

`command -v areal` 应指向所选安装的入口；多个前缀并存时检查 PATH，必要时运行 `hash -r`。`build-info` 给出源码提交；完整包 `manifest.json` 给出平台和逐文件 SHA-256，与同一 Release 的 `SHA256SUMS` 一起保留。

当前源码将入口更新与后台换代分开：安装器只校验完整新包并原子切换入口，不停止后台，不修改配置/历史，也不删除旧版本。服务在下载或切换期间启动仍可使用其已解析的完整旧包；不同工作区与 GUI 实例不因安装被停止。安装器拒绝同一前缀并发安装。已发布 0.1.6 的 `areal upgrade` 内嵌旧的停服前置检查，无法因目标版本更新而自动获得新入口行为；可使用目标 Release 已校验的安装器更新，无需强制冷迁移。

新客户端遇到不兼容后台时清楚提示，不能隐式停止、降级或抢占旧后台。待任务空闲后，通过原客户端的显式更新/重启流程交接；受理结果未知时只检查原请求，不重发停止。保留旧包不等于备份数据格式，切换后先核对活动入口和后台各自版本。

下载中断、摘要错误、程序版本不符或入口切换失败时，旧入口与配置/历史保持原样，可修复原因后重试。若入口已经切换后才中断，新版本可能已激活；先核对入口和版本，不能直接删除候选目录。强制终止进程可能遗留暂存或未激活的版本目录；不要删除旧安装或用户数据。同版本目录已存在时先核对其完整性和当前入口，不直接覆盖。回退程序前先停止服务，再将入口符号链接指回保留的旧版本；若新版本已写入数据，需配套恢复升级前备份，旧版本读取新格式不作保证。

## 配置、升级与卸载

按[配置指南](configuration.md)在 `~/.areal/config.toml` 配置模型，然后在工作区启动 `areal`。旧配置必须删除已移除的 `limits.turn_timeout_seconds` 和 `AREAL_HARNESS_TURN_TIMEOUT_SECONDS`。`areal config validate` 可检查配置。旧 `~/.areal-harness` 不会自动迁移。

`areal version` 与 `areal --version` 等价。`areal upgrade --check` 查询原安装渠道版本，不安装（独立安装的正式版查询最新正式 CLI，Beta 版查询最新 Beta 与正式版中较高者；Homebrew 查询原 formula）。交互式 TUI 启动时也会在后台按同样渠道检查，24 小时内最多联网一次，有新版本时在页眉第二行提示运行 `areal upgrade`，从不自动安装；设置 `AREAL_NO_UPDATE_CHECK=1` 可关闭，源码构建不检查。TUI 连到比自身旧的后台时同样提示：任务空闲后运行 `areal host stop`，再重开即由新版本拉起后台。`areal upgrade` 按原安装来源执行；源码构建或非安装器管理的复制品拒绝自升级。

- **独立安装**先校验完整新包，再原子切换命令入口，不要求停止共享服务。升级命令不停止或重启后台，也不迁移运行中的会话。旧版本目录保持不变，供原有进程及其 Runtime 继续使用；新命令入口指向新版本。不应手动删除仍被运行中进程使用的版本目录。
- **Homebrew 安装**使用 formula 并核对安装版本，tap 尚未更新会报错。此渠道仍要求所有共享服务停止后才能执行 `areal upgrade`，因为该命令不控制 Homebrew 对旧版本目录的清理。先用 `areal service list` 检查服务，再在各工作区执行 `areal service stop --workspace /absolute/workspace`。忙碌任务默认拒绝停止，应先完成或显式暂停任务，不要为了升级强制取消任务。

安装新版本不等于后台已切换到新版本。TUI 启动、重连和 `areal service ensure` 不隐式切换二进制版本；需要更新后台时，先完成或暂停其任务，再用新版入口执行 `areal service restart --workspace /absolute/workspace`，或通过 GUI 的显式后台更新入口操作。换代后，旧 TUI 的自动重连不会停止新版后台；要继续使用，请从新版入口重开 TUI。不要直接覆盖运行中的二进制。独立安装保留旧版本目录，可在停止服务后手动切回旧入口；数据格式升级后不能保证旧版本可读取新状态，升级前备份 `~/.areal`。

新版 CLI 使用持久停止回执管理后台，兼容 0.1.5 Host。0.1.4 等旧 Host 不支持这项能力时，先用原版本 CLI 显式停止，再启动新版；新版不会尝试旧式停止来探测兼容性。

卸载先停止服务。Homebrew 用 `brew uninstall areal`；Linux 删除安装器管理的入口链接及选定版本目录。两种方式都不自动删除 `~/.areal` 的配置与历史。

符号链接入口先解析到真实版本目录，再定位 `libexec/areal`，适用于 Homebrew Cellar 和 Linux 版本化安装。

## 桌面 GUI（macOS Apple Silicon）

从 GitHub Release 下载 DMG，或用 Homebrew：

```sh
brew install --cask areal-project/tap/areal-harness
# 可选 Beta（与正式版互斥）
brew install --cask areal-project/tap/areal-harness@beta
```

GUI 自带同版本的后台程序并自行更新，`brew upgrade` 默认不覆盖它。默认只接收正式版；在 设置 → 通用 → 软件更新 → 高级 打开“接收 Beta 版本”后改为接收 Beta，后台也随之更新。关闭后不会降级，停在当前版本直到正式版追上。通过 `areal-harness@beta` 安装的也需打开这个开关才会继续收到 Beta。

## 源码安装

运行 `make install` 构建 release 并安装完整 Runtime，默认前缀为 `/usr/local`。可用 `make install PREFIX="$HOME/.local"` 安装到用户目录，或用 `DESTDIR=/tmp/package` 暂存打包。搜索通过文件助手内置的 ripgrep Rust 库执行，无需单独安装 rg；命令行任务需要 rg 时仍须自行安装。
