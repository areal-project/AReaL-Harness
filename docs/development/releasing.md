**中文** | [English](releasing.en.md)

# 发行包发布

当前可验收的独立渠道为 macOS arm64 与 Linux x86_64 glibc 完整包 + Python 安装器；两平台共用 Homebrew formula。与 [Codex CLI 官方安装矩阵](https://learn.chatgpt.com/docs/codex/cli#getting-started)相比，npm、Windows 在本项目尚无完整 Runtime 包或原生支持，不能列为可用渠道。`cargo install areal-cli` 同样不提供完整布局。安装范围见[安装指南](../guides/installation.md)。

打包暂存阶段会独立加载 Cloud 后台模块，并执行本地阅读标记路由，校验公开包入口在安装包目录内可解析；此检查在签名与公证前运行。

## 渠道与来源门禁

CLI 正式与预览均交付完整 bundle；macOS 保留并严格验证输入 ad-hoc 签名，不做 Developer ID 分发签名或 Apple 公证。GUI 正式版继续使用 Developer ID + 公证、DMG 与更新 ZIP；GUI 预览保留默认 ad-hoc，仅手动安装，不带正式更新配置、不推进正式 feed，也不承诺自动转正式。预览标记 prerelease、非 Latest；仅 CLI 正式版可成为 Latest。

正式导出前先 `git fetch origin main`，再运行 `python3 scripts/release-source.py --revision "$(git rev-parse HEAD)"`。它要求干净 checkout 的完整 HEAD SHA 已属于获取的 main；离线旧 ref 不能代替发布前重新获取。CLI tag 构建和 GUI 正式附件导出执行此门禁，PR 候选仍允许验证未合并源码。GUI 导出必须与候选 Core 的源码提交一致，清单同时记录已核对的 main 提交。版本、commit、平台和校验和随产物保存；公开版本附件不得覆盖。尚未公开的候选与预览不自动改变正式频道。

## 候选构建

CLI/GUI 安装包在干净的选定提交上本地构建、验收和发布。PR 通过稳定的 `Release gate` 运行发行契约测试，不构建完整包、不执行安装升级包验收、不上传候选或发布；推送 tag 也不启动打包。既有 `Release bundles` 手动 workflow 仅保留显式 `workflow_dispatch` 入口，常规发行使用下方本地命令。固定 Rust 工具链与 Cargo.lock；macOS 15 arm64、Ubuntu 22.04 x86_64 分别原生构建。

本地发行验收执行 `make release`、生成完整 bundle 与逐文件 manifest、生成 tar.gz 和 SHA256，然后解压到含空格的新路径，以本地 HTTP 模型 fixture 验证真实命令写入与文件读取。Linux 执行安装器再验证安装入口，并验证原生工具；两平台在隔离 Homebrew prefix 验证稳定与 beta 安装升级，执行 `brew test` 和真实读写；macOS 另外运行 release-profile 的 bundle 生命周期 soak。

macOS 打包保留构建产物的签名与原始字节，并执行 `codesign --verify --strict`；签名缺失或无效时停止打包，需修复构建产物。打包不强制重签二进制，manifest 校验和对应实际复制的文件。

`release-artifacts.py` 拒绝 dirty working tree 或非 release-profile 的 manifest。候选输出包括平台 tar.gz、manifest、SHA256 sidecar；draft 汇总双平台归档后，生成带最终下载 URL 和真实归档 SHA256 的对应渠道 formula。不要手工编写占位 SHA256，也不要将 CI 候选发布为已验收正式版本。

macOS 完整包还包含独立执行的 Bash（版本与全部源文件校验和见 `runtime/host-tools/bash.lock.json`），位于 `libexec/areal/shells`。构建入口为 `scripts/prepare-runtime-shell.py`；打包核对锁文件、构建脚本、二进制与源码归档摘要，缺失或不一致即拒绝。`COPYING`、完整 `corresponding-source.tar.gz`（原始归档、全部补丁、锁文件和构建脚本）及 `build.json` 随相同二进制分发，并记录在 manifest 的 `thirdPartyComponents`。不能仅分发二进制或用项目 Apache 许可证覆盖这一 GPL-3.0-or-later 独立组件；源码可由归档离线重建。Linux 不新增该组件。

私有 shell 的最低系统版本由锁文件 `minimumMacOSVersion` 固定为 15.0，构建显式传入 `MACOSX_DEPLOYMENT_TARGET`，打包核对构建信息与锁文件一致。原生验收还需用 `otool -l` 核对 Mach-O 的 `LC_BUILD_VERSION`，避免本机新 SDK 使独立组件高于项目支持范围。

## 发布步骤

1. 合并发布准备变更；确认选定提交的 PR 检查与本地发行验收通过，并检查当前版本、许可证和迁移说明。
2. 审阅两平台候选、Homebrew 测试和 Linux 安装日志，确认版本及支持范围。
3. 在固定提交创建尚未使用的 `v<版本>` tag（预览为 `vX.Y.Z-beta.N`）；tag 必须与 `areal --version` 一致，不覆盖已有 tag。在本机完成两平台构建和验收后，创建 **draft** Release 并上传已验证附件；创建 tag 不触发打包或发布。
4. 对照本地产物和已上传 draft 附件，核对 SHA256SUMS、manifest 中的 sourceRevision、profile 和平台；补齐简短中英文 release notes，仅写本次用户可见变化、重要修复与必要升级注意。macOS 尚无 Developer ID/公证，不应标为已公证。
5. 按已有授权公开 draft，再按下方公共 tap 流程同步对应渠道：正式版只更新 `Formula/areal.rb`，beta 只更新 `Formula/areal-beta.rb`。先确认公共仓库、对应 formula 和归档可下载，再提供相应安装命令；同步失败不能声称 Homebrew 可用。
6. 在 macOS arm64 与 Linux x86_64 的隔离环境，从公共地址验证 Homebrew 首装、旧版升级、实际来源路由、渠道隔离和完整 Runtime，并保留独立安装器回归；记录发行 digest 与最终结果。后续版本重复本流程，不替换已公开版本的归档。

Release tag 与公开、tap 创建/更新是外部发布操作，应在产物审阅完成后执行。draft job 不覆盖已有 Release；失败重试前应先检查已存在的远端状态，避免替换已公开资产。GitHub Release 不是 Linux 容器镜像发布，此流程不推送镜像。

## 本地命令

bundle manifest 的 `apiVersion` 来自已生成的 `schemas/areal-core-v1.json`，`stateVersion` 来自 Core Store 的版本常量；缺失或不明确时在复制和签名前拒绝打包。复用已构建二进制时仍须核对其实际协议/状态版本与该源码一致，清单不代替二进制验收。

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

Homebrew formula 安装 `bin`、`libexec`、LICENSE 和 manifest，避免改变 Core 查找 helper 的相对路径。安装器将不同版本放在不同目录，只原子替换入口符号链接；用户配置与历史不由安装器维护。校验、版本探测或入口提交失败均不得切换旧入口。`install-smoke.py` 在隔离目录用真实完整包/共享服务验证入口更新时保留真实运行中服务的 PID、generation 和完整旧包；本地发行验收必须运行该脚本。普通脚本测试使用合成包覆盖异常，不启动用户服务。

## 可选平台适配包

外部平台通过 [CLI 契约](../api/claude-cli.md) 消费标准原生发布包。旧 EnvArena Python zipapp 及专用打包工作流不再分发。

维护仓库保护规则时，不要将可选适配器 job 设为普通 PR 的必需检查；若已有旧 `Arena package` 必需规则，需在仓库设置中移除。该设置独立于工作流文件。

## GUI 发布

本机无需新增签名时可使用 `AREAL_GUI_UNSIGNED_LOCAL=1 AREAL_GUI_PACKAGE_DIR=/绝对路径/新目录 pnpm --dir clients/gui package`，CLI bundle 对应 `python3 scripts/package.py --unsigned-local --profile debug --output /绝对路径/新目录`。该显式模式跳过 Core 副本和整个 app 的签名，builder 继续使用 `identity: null`；保留输入字节及已有签名，记录真实 bundle 签名核验结果，不移除签名或改变系统策略。它与 `AREAL_GUI_RELEASE=1` 互斥；默认流程仍创建本机 ad-hoc 签名。已生成 ZIP 不证明能启动，须从 ZIP 复制到新隔离目录验收，系统拒绝时保留首次失败并停止该启动路径。

默认本机 ad-hoc 打包输出 `.app`、`AReaL-Harness-GUI-mac-arm64.zip` 和同名 `.dmg`。只需要 DMG 时，使用 `AREAL_GUI_RELEASE=0 AREAL_GUI_UNSIGNED_LOCAL=0 pnpm --dir clients/gui package --dmg-only`；保留签名后的 `.app` 中间产物，不生成 ZIP。该选项不能与正式模式或无新增签名模式组合。`package-evidence.json` 记录 DMG 路径、压缩大小、SHA-256 和框架硬链接核验数量。`AREAL_GUI_UNSIGNED_LOCAL=1` 与正式签名前的 `AREAL_GUI_RELEASE=1` 仍只导出 ZIP。

已有签名 app 可单独导出预览 DMG，输出路径必须尚不存在：

```sh
node clients/gui/scripts/macos-dmg.mjs --app "/absolute/AReaL Harness GUI.app" \
  --output /absolute/new-preview.dmg --volume-name "AReaL Harness Preview"
```

预览与正式 DMG 共用导出器。导出器保留源 app，在私有副本中证明两份 Electron framework 的全部文件 payload、布局和签名策略等价，再把对应普通文件改为硬链接。签名不同的代码只在一次性文件副本中移除签名以比较完整字节；不支持的差异直接失败。主应用与后台仍保留独立 helper、元数据和本地框架目录。导出器不签名；它在最后一次 app 签名之后创建 HFS+ UDZO DMG，并只在只读挂载的签名、布局及共享 inode 核验通过后发布。正式流程随后继续 DMG 签名、公证和 stapling。ZIP 格式及更新路径不变，不承诺 ZIP 体积下降。ad-hoc 预览不建立 Apple 分发信任。

GUI 版本由 `clients/gui/package.json` 和 `clients/gui/app/package.json` 共同声明，与 Cargo/CLI 版本独立。发布地址统一为 `areal-project/AReaL-Harness`；版本 Release 使用 `gui-v<版本>` 标签，CLI 继续使用 `v<版本>`。GUI Release 不设为 GitHub Latest，避免改变 CLI 安装器的 Latest 语义。

正式 GUI 包内写入 `areal-update.json`，更新源固定为 `https://github.com/areal-project/AReaL-Harness/releases/download/gui-update-channel/`。`gui-update-channel` 是仅承载当前 `latest-mac.yml` 的预发布频道；清单指向不可变 `gui-v<版本>` Release 中的 ZIP，并包含大小及 SHA-512。仅接受同仓库、同版本的附件地址。本地 ad-hoc 包没有更新配置。

macOS `dir` 目标不会自动生成原生更新配置。正式打包在签名前写入 `app-update.yml`，沿用同一产品更新源和固定下载缓存名，并校验包内配置；仍禁止 builder 自动上传。仅能发现新版本不证明能下载。侧栏更新按钮显示下载进度，失败时直接显示原因并允许重试。更新重开时先核对原操作回执和旧后台进程退出；已完成的更新继续初始化新后台，未确认或未完成操作仍保留恢复引用。明确停止后台的操作仍需用户主动重连。

安装先完成空闲检查、安全停止和当前安装占用检查，再触发 Squirrel 原生准备。只有 UID、真实可执行路径、进程身份和对应数据库均属于本会话的崩溃报告进程可被排除；其他会话、独立 CLI 和未知占用仍阻断安装。下载或摘要失败保留后台；原生准备失败发生在安全停止之后，需退出重开核对版本，不能自动重复安装。

在干净、已合并的提交上执行：

```sh
make release
AREAL_GUI_RELEASE=1 AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
node clients/gui/scripts/release-assets.mjs /absolute/new-signed-directory /absolute/new-assets
```

签名脚本先签 Core 可执行文件并更新完整性摘要，再签 Electron 应用；后台服务的共享资源链接按物理文件身份识别，外层签名不得重复签 Core；外层签名完成后、Apple 上传前再次校验 Core 摘要。Apple Accepted 回执、stapler、Gatekeeper、签名后隔离 GUI/Core/Runtime smoke、模型配置与 Composer 专项以及只读 DMG 内签名验证均通过才完成。`notarization.json` 与脱敏 `release.json` 记录 `packagedModelSelection: "passed"`；导出脚本拒绝没有该项验收的旧候选，需要使用当前签名脚本生成新候选。Apple 仍在处理时退出 2，使用同脚本的 `--resume --output` 恢复；不可修改已签名应用。

签名前先执行 `history-copy-smoke.mjs`：默认只读安装版的 `~/Library/Application Support/AReaL Harness GUI/areal-core`，`--history-source /absolute/areal-core` 可指定另一份历史。脚本将项目索引、会话、历史归档和附件复制到权限受限的隔离目录，受控样本的占位工作区在副本中填充；私有副本保留原始会话字节和工作区路径，以满足 Core 的归属校验，只观察、不执行任务。不复制凭据、锁或部署配置，不写原始历史。仅接受空闲、没有待执行队列或未结算执行状态的历史；其他输入会阻断签名。 已完成的子会话执行引用仅在同项目副本中存在对应终态轮次时接受；未结算引用、工作组及受管进程/工作流状态仍阻断签名。候选包必须能连接 Core、打开每个会话，且打开期间副本字节不变、全过程来源字节不变、没有模型请求。停止测试后台导致的副本队列版本变化单独处理。失败发生在签名身份检查及 Apple 请求之前；成功证据绑定候选 Core 哈希并写入 `notarization.json.historyPreflight`。没有该预检记录的旧签名运行不能通过 `--resume` 绕过，需启动新运行。

登记后尚未启动 Core 的项目可以没有状态目录，已连接但没有会话的项目也可以为空。预检保留这些项目，在副本中连接并确认没有创建会话；来源状态目录的存在性及条目在检查期间必须保持不变。存在的状态路径仍必须是普通目录，不能通过符号链接绕过检查；现有会话仍须满足全部空闲和归属约束。

CI 在现有 GUI 检查中运行 `pnpm --dir clients/gui run test:history-compat`，默认使用 `clients/gui/scripts/fixtures/history-compat/` 的人工合成脱敏样本，包含空项目、`hookRuns`、`allowPluginSkills`、`pluginSkills`；这些文件不来自用户历史，也不包含真实路径或凭据。本机可单独执行 `node clients/gui/scripts/history-copy-smoke.mjs --source /absolute/areal-core --executable "/absolute/candidate.app/Contents/MacOS/AReaL Harness GUI"`；省略 `--executable` 时使用开发 Electron 和已构建 Core。没有日常历史的构建机可显式将 `--history-source` 指向受控样本目录；这仅证明样本兼容，不代表本机历史兼容。私有副本和失败证据保留在脚本输出的 `/private/tmp/ahc-*`，不得作为公开发布附件。

在固定提交创建 `gui-v<版本>` 标签，以 draft 上传 ZIP、DMG、`latest-mac.yml`、脱敏 `release.json` 与 `SHA256SUMS`；回读摘要后公开，保持 `--latest=false`。先确认版本附件可下载，再更新 `gui-update-channel` 的清单；首次创建该频道时使用 prerelease。公开后核对完整字节、HTTP Range、清单大小及 SHA-512。版本附件不可覆盖；频道清单按已验收版本推进。此流程不发布 CLI 包，也不更新 Homebrew tap。

GUI 只支持 macOS arm64 更新，检查和下载由 Electron 持有，后台任务空闲并完成原生校验后才关闭 Core 并安装。公开附件与包内 smoke 不证明既有安装已经完成自动替换；旧安装到新版本的实际升级需要单独验收。其他仓库或旧测试频道的客户端不会自动迁移到本频道，需要手动安装首个正式 GUI 包。

`pnpm --dir clients/gui run test:update` 通过真实 Electron preload/IPC 验证下载错误可见与重试进度。设置 `AREAL_GUI_EXECUTABLE` 为候选包入口，并设置 `AREAL_GUI_UPDATE_BASELINE` 为较旧已签名 GUI 的入口，可额外验证候选包的原生配置、公开 ZIP 下载与 SHA-512 校验、Squirrel 原生准备和安全停止 Core。脚本只启动旧基线的隔离副本，借用候选配置，不修改签名资源；截获最终安装调用后退出，核对 Squirrel 自动替换的副本版本，不触碰原基线或用户安装。证据目录由脚本输出。

## 构建身份与 GUI 兼容

`areal build-info` 查询二进制内嵌的 Core revision、dirty 状态和 Rust/Cargo/schema 输入哈希，以及 API/Store 版本。打包先核对输入哈希和 revision；旧二进制不能以新 checkout 身份进入 manifest。格式 2 manifest 保存 coreBuild 和各输入组件的真实字节哈希，sourceRevision 专指 Core 构建身份，不单独声称每个 Runtime 二进制的编译来源。GUI 兼容已有格式 1 包；格式 2 同时要求 coreBuild 与 manifest 的 API、Store 和 revision 一致。GUI 要求 areal.core.v1、匹配平台及支持的持久版本，Store 仍由 Core 读取；源码输入变化后须重新构建再打包。三份 schema 通过 `make desktop-schema-check` 临时生成规范化比较，`make desktop-schemas` 全部生成成功后原子替换。

## 公共 tap 与渠道同步

`release-artifacts.py formula` 接受同版本两个 `--archive`，生成 macOS arm64/Linux x86_64 条件 formula，使用各自真实 SHA256。正式版输出 `areal.rb`；beta 输出 `areal-beta.rb`，keg-only，不覆盖稳定入口。Linux 需要宿主 glibc ≥ 2.35 与系统 `/usr/bin/bwrap`；不要把 macOS 限制放到 Linux 分支。

CLI Release 公开后不自动同步 tap；按下方命令在本机同步对应渠道，既有 `Sync public Homebrew tap` 手动 workflow 仅保留显式 workflow_dispatch 入口。它保持 `contents: read`，只使用预先批准的 `HOMEBREW_TAP_TOKEN` 跨仓库授权；缺失时明确失败，不创建凭据或把发行成功当作 tap 同步成功。组织仓库不存在、写权限不足或 checksum 失败均阻断同步，但不覆盖/撤销已公开附件。由维护者按授权补齐仓库/权限后重试同一 tag；不能为了恢复扩大 token 或 workflow 权限。

具有既有 tap 写权限的维护者也可手动同步，脚本只接受已公开且渠道正确的 Release，重新下载双平台归档并校验，拒绝 formula 降级：

```sh
git clone https://github.com/areal-project/homebrew-tap.git /absolute/new-tap
python3 scripts/sync-homebrew.py --tag vX.Y.Z --tap-checkout /absolute/new-tap --push
# beta 指定真实已公开的 vX.Y.Z-beta.N；只写 Formula/areal-beta.rb
```

脚本不会创建仓库或凭据。公共渠道验收必须在未认证的公开地址核查 tap、formula、双平台归档和 SHA256，并在两平台的隔离 Homebrew prefix 实测首次安装、旧版升级、实际来源路由和稳定/beta 隔离。`homebrew-smoke.py` 在 macOS/Linux runner 执行原生候选验收；其中 `areal-validation/channel` 是隔离测试 tap，不等于公共 tap 验收。安装器完整性、Linux 原生工具、真实运行任务及旧包保留检查继续执行。Homebrew 可能清理旧 keg，升级要求先让任务完成并安全停服；不隐式停止后台。

Linux 完整包仍在 Ubuntu 22.04 / glibc 2.35 原生构建并执行安装器、工具回归；Linuxbrew 在 Ubuntu 24.04 上下载并验证同一归档。Homebrew 自身当前需要较新的 glibc，旧宿主与长自定义 prefix 会触发其额外工具链引导，不能把该行为当作产品 glibc 基线变化，也不能跳过依赖检查冒充验收通过。两项均保留为本地发行验收与草稿发布前的必需证据。
