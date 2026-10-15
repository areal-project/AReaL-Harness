**中文** | [English](releasing.en.md)

# 发行包发布

当前可验收的独立渠道为 macOS arm64 与 Linux x86_64 glibc 完整包 + Python 安装器；macOS 另可发布 Homebrew formula。与 [Codex CLI 官方安装矩阵](https://learn.chatgpt.com/docs/codex/cli#getting-started)相比，npm、Windows 在本项目尚无完整 Runtime 包或原生支持，不能列为可用渠道。`cargo install areal-cli` 同样不提供完整布局。安装范围见[安装指南](../guides/installation.md)。

## 候选构建

`Release bundles` workflow 可通过相关 PR 或 workflow_dispatch 构建候选；这两种触发只上传 CI artifacts，不创建 Git tag 或 Release。固定 Rust 工具链与 Cargo.lock；macOS 15 arm64、Ubuntu 22.04 x86_64 分别原生构建。

流水线执行 `make release`、生成完整 bundle 与逐文件 manifest、生成 tar.gz 和 SHA256，然后解压到含空格的新路径，以本地 HTTP 模型 fixture 验证真实命令写入与文件读取。Linux 执行安装器再验证安装入口，并验证原生工具；macOS 在临时 tap 安装本地同一归档，执行 `brew test` 和真实读写，再运行 release-profile 的 bundle 生命周期 soak。

macOS 打包保留构建产物的签名与原始字节，并执行 `codesign --verify --strict`；签名缺失或无效时停止打包，需修复构建产物。打包不强制重签二进制，manifest 校验和对应实际复制的文件。

`release-artifacts.py` 拒绝 dirty working tree 或非 release-profile 的 manifest。候选输出包括平台 tar.gz、manifest、SHA256 sidecar；macOS 另生成最终下载 URL 和真实归档 SHA256 的 `areal.rb`。不要手工编写占位 SHA256，也不要将 CI 候选发布为已验收正式版本。

## 发布步骤

正式版本统一使用 `v<Core版本>` Release，附件同时包含 macOS arm64 与 Linux x86_64 的 Core/CLI/Runtime 完整包、GUI ZIP/DMG、安装器、Homebrew formula、各平台 manifest、GUI 验收摘要、更新清单、总发行清单和 SHA256SUMS。GUI 保留独立递增版本；例如 `v0.1.5` 对应 Core 0.1.5、GUI 0.1.9，不能为了统一 Release 而降低 GUI 版本。

1. 合并发布准备变更，确认固定提交的 Verify、GUI checks 和 Release bundles 全部通过，核对版本、许可证和兼容性说明。
2. 在同一干净提交构建并按下文签名、公证、验收 GUI；以 `gui-v<GUI版本>` 标签创建 draft，上传 GUI 导出目录的全部文件。它是旧 GUI 更新器的兼容入口，不作为主发行版本，也不设为 Latest。不要复用旧版本 GUI 或只修改其来源元数据。
3. 在同一提交创建 `v0.1.5` tag，必须与 `areal --version` 一致。tag workflow 重建并验收两平台 Core bundle，下载匹配 GUI 版本的 draft 附件，并执行 `release-artifacts.py assemble`。缺失 GUI、签名验收不通过、版本/提交不匹配、文件或摘要不一致时失败，不创建缺件的主 Release；修复候选后可重跑失败 job。
4. 汇总只输出公开附件，验证归档内逐文件摘要与 sidecar manifest、两平台协议/状态版本，以及 GUI 的同提交、同 Core 版本、ZIP/DMG 摘要和 Accepted 公证回执。生成 `release-manifest.json` 和覆盖所有附件的 `SHA256SUMS`；GUI 的本机路径、原始历史与签名日志不上传。
5. 下载统一 draft，回读全部摘要和来源，补齐中英文 release notes，说明各组件版本、依赖和签名范围。独立 macOS Core 包保留构建签名，不应因同一 Release 的 GUI 已公证而标为 Developer ID 公证。
6. 在已获发布授权、产物审阅完成后公开 GUI 兼容入口（`--latest=false`），确认其 ZIP 可下载，再公开统一 Release 并设为 Latest。最后推进 `gui-update-channel`，保证旧更新器继续接受 `gui-v<GUI版本>` 地址。所有主要下载从统一 Release 导航。
7. 如需维护 Homebrew tap，将统一 Release 的 `areal.rb` 更新到 `areal-project/homebrew-tap`；确认公开 URL 可用后测试安装。在干净 Linux 上用公开地址安装并跑读写验收，核对发行摘要与结果。

版本附件不可覆盖，失败重试前检查远端状态；已公开 Release 不得替换归档。只有更新频道清单可以按已验收版本推进。此流程不发布 Linux 容器镜像、npm SDK 或尚未支持的平台包。

## 本地命令

bundle manifest 的 `apiVersion` 来自已生成的 `schemas/areal-core-v1.json`，`stateVersion` 来自 Core Store 的版本常量；缺失或不明确时在复制和签名前拒绝打包。复用已构建二进制时仍须核对其实际协议/状态版本与该源码一致，清单不代替二进制验收。

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

同一提交的 Core artifacts 和已导出的正式 GUI 可在本地汇总；输出必须是新目录：

```sh
python3 scripts/release-artifacts.py assemble \
  --core-assets /absolute/core-assets --gui-assets /absolute/gui-assets \
  --output /absolute/new-complete-release --version 0.1.5 \
  --revision "$(git rev-parse HEAD)"
```

`--core-assets` 包含两平台归档、`.sha256` 和 `manifest-*.json`；`--gui-assets` 是 `release-assets.mjs` 的完整输出。汇总重新生成指向旧 GUI 兼容入口的 `latest-mac.yml`（JSON 兼容 YAML），保留已安装客户端的严格 URL 校验。

Homebrew formula 安装 `bin`、`libexec`、LICENSE 和 manifest，避免改变 Core 查找 helper 的相对路径。Linux 安装器将不同版本放在不同目录，只原子替换入口符号链接；用户配置与历史不由安装器维护。校验失败不得切换入口。

## 可选平台适配包

外部平台通过 [CLI 契约](../api/claude-cli.md) 消费标准原生发布包。旧 EnvArena Python zipapp 及专用打包工作流不再分发。

维护仓库保护规则时，不要将可选适配器 job 设为普通 PR 的必需检查；若已有旧 `Arena package` 必需规则，需在仓库设置中移除。该设置独立于工作流文件。

## GUI 发布

本机无需新增签名时可使用 `AREAL_GUI_UNSIGNED_LOCAL=1 AREAL_GUI_PACKAGE_DIR=/绝对路径/新目录 pnpm --dir clients/gui package`，CLI bundle 对应 `python3 scripts/package.py --unsigned-local --profile debug --output /绝对路径/新目录`。该显式模式跳过 Core 副本和整个 app 的签名，builder 继续使用 `identity: null`；保留输入字节及已有签名，记录真实 bundle 签名核验结果，不移除签名或改变系统策略。它与 `AREAL_GUI_RELEASE=1` 互斥；默认流程仍创建本机 ad-hoc 签名。已生成 ZIP 不证明能启动，须从 ZIP 复制到新隔离目录验收，系统拒绝时保留首次失败并停止该启动路径。

GUI 版本由 `clients/gui/package.json` 和 `clients/gui/app/package.json` 共同声明，与 Cargo/CLI 版本独立。发布地址统一为 `areal-project/AReaL-Harness`；版本 Release 使用 `gui-v<版本>` 标签，CLI 继续使用 `v<版本>`。GUI 兼容 Release 不设为 GitHub Latest；主发行使用上文统一 `v<Core版本>` Release，保持 CLI 安装器的 Latest 语义。

正式 GUI 包内写入 `areal-update.json`，更新源固定为 `https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/`。`gui-update-channel` 是仅承载当前 `latest-mac.yml` 的预发布频道；清单指向不可变 `gui-v<版本>` Release 中的 ZIP，并包含大小及 SHA-512。仅接受同仓库、同版本的附件地址。本地 ad-hoc 包没有更新配置。

macOS `dir` 目标不会自动生成原生更新配置。正式打包在签名前写入 `app-update.yml`，沿用同一产品更新源和固定下载缓存名，并校验包内配置；仍禁止 builder 自动上传。仅能发现新版本不证明能下载。侧栏更新按钮显示下载进度，失败时直接显示原因并允许重试。

在干净、已合并的提交上执行：

```sh
make release
AREAL_GUI_RELEASE=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
node clients/gui/scripts/release-assets.mjs /absolute/new-signed-directory /absolute/new-assets
```

签名脚本先签 Core 可执行文件并更新完整性摘要，再签 Electron 应用；Apple Accepted 回执、stapler、Gatekeeper、签名后隔离 GUI/Core/Runtime smoke、模型配置与 Composer 专项以及只读 DMG 内签名验证均通过才完成。`notarization.json` 与脱敏 `release.json` 记录 `packagedModelSelection: "passed"`；导出脚本拒绝没有该项验收的旧候选，需要使用当前签名脚本生成新候选。Apple 仍在处理时退出 2，使用同脚本的 `--resume --output` 恢复；不可修改已签名应用。

签名前先执行 `history-copy-smoke.mjs`：默认只读安装版的 `~/Library/Application Support/AReaL Harness GUI/areal-core`，`--history-source /absolute/areal-core` 可指定另一份历史。脚本将项目索引、会话、历史归档和附件复制到权限受限的隔离目录，受控样本的占位工作区在副本中填充；私有副本保留原始会话字节和工作区路径，以满足 Core 的归属校验，只观察、不执行任务。不复制凭据、锁或部署配置，不写原始历史。仅接受空闲、没有待执行队列或未结算执行状态的历史；其他输入会阻断签名。 已完成的子会话执行引用仅在同项目副本中存在对应终态轮次时接受；未结算引用、工作组及受管进程/工作流状态仍阻断签名。候选包必须能连接 Core、打开每个会话，且打开期间副本字节不变、全过程来源字节不变、没有模型请求。停止测试后台导致的副本队列版本变化单独处理。失败发生在签名身份检查及 Apple 请求之前；成功证据绑定候选 Core 哈希并写入 `notarization.json.historyPreflight`。没有该预检记录的旧签名运行不能通过 `--resume` 绕过，需启动新运行。

CI 在现有 GUI 检查中运行 `pnpm --dir clients/gui run test:history-compat`，默认使用 `clients/gui/scripts/fixtures/history-compat/` 的人工合成脱敏样本，包含 `hookRuns`、`allowPluginSkills`、`pluginSkills`；这些文件不来自用户历史，也不包含真实路径或凭据。本机可单独执行 `node clients/gui/scripts/history-copy-smoke.mjs --source /absolute/areal-core --executable "/absolute/candidate.app/Contents/MacOS/AReaL Harness GUI"`；省略 `--executable` 时使用开发 Electron 和已构建 Core。没有日常历史的构建机可显式将 `--history-source` 指向受控样本目录；这仅证明样本兼容，不代表本机历史兼容。私有副本和失败证据保留在脚本输出的 `/private/tmp/ahc-*`，不得作为公开发布附件。

在固定提交创建 `gui-v<版本>` 标签，以 draft 上传 ZIP、DMG、`latest-mac.yml`、脱敏 `release.json` 与 `SHA256SUMS`；回读摘要后公开，保持 `--latest=false`。先确认版本附件可下载，再更新 `gui-update-channel` 的清单；首次创建该频道时使用 prerelease。公开后核对完整字节、HTTP Range、清单大小及 SHA-512。版本附件不可覆盖；频道清单按已验收版本推进。此兼容入口与统一 Release 使用相同的 GUI ZIP/DMG 字节；Core 包和 Homebrew formula 由上文统一流程汇总。

GUI 只支持 macOS arm64 更新，检查和下载由 Electron 持有，后台任务空闲并完成原生校验后才关闭 Core 并安装。公开附件与包内 smoke 不证明既有安装已经完成自动替换；旧安装到新版本的实际升级需要单独验收。其他仓库或旧测试频道的客户端不会自动迁移到本频道，需要手动安装首个正式 GUI 包。

`pnpm --dir clients/gui run test:update` 通过真实 Electron preload/IPC 验证下载错误可见与重试进度。设置 `AREAL_GUI_EXECUTABLE` 为候选包入口，并设置 `AREAL_GUI_UPDATE_BASELINE` 为较旧已签名 GUI 的入口，可额外验证候选包的原生配置、公开 ZIP 下载与 SHA-512 校验、Squirrel 原生准备和安全停止 Core。脚本只启动旧基线的隔离副本，借用候选配置，不修改签名资源；截获最终安装调用后退出，核对 Squirrel 自动替换的副本版本，不触碰原基线或用户安装。证据目录由脚本输出。

## 构建身份与 GUI 兼容

`areal build-info` 查询二进制内嵌的 Core revision、dirty 状态和 Rust/Cargo/schema 输入哈希，以及 API/Store 版本。打包先核对输入哈希和 revision；旧二进制不能以新 checkout 身份进入 manifest。格式 2 manifest 保存 coreBuild 和各输入组件的真实字节哈希，sourceRevision 专指 Core 构建身份，不单独声称每个 Runtime 二进制的编译来源。GUI 兼容已有格式 1 包；格式 2 同时要求 coreBuild 与 manifest 的 API、Store 和 revision 一致。GUI 要求 areal.core.v1、匹配平台及支持的持久版本，Store 仍由 Core 读取；源码输入变化后须重新构建再打包。三份 schema 通过 `make desktop-schema-check` 临时生成规范化比较，`make desktop-schemas` 全部生成成功后原子替换。
