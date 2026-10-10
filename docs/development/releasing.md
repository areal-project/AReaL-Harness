**中文** | [English](releasing.en.md)

# 发行包发布

当前可验收的独立渠道为 macOS arm64 与 Linux x86_64 glibc 完整包 + Python 安装器；macOS 另可发布 Homebrew formula。与 [Codex CLI 官方安装矩阵](https://learn.chatgpt.com/docs/codex/cli#getting-started)相比，npm、Windows 在本项目尚无完整 Runtime 包或原生支持，不能列为可用渠道。`cargo install areal-cli` 同样不提供完整布局。安装范围见[安装指南](../guides/installation.md)。

## 候选构建

`Release bundles` workflow 可通过相关 PR 或 workflow_dispatch 构建候选；这两种触发只上传 CI artifacts，不创建 Git tag 或 Release。固定 Rust 工具链与 Cargo.lock；macOS 15 arm64、Ubuntu 22.04 x86_64 分别原生构建。

流水线执行 `make release`、生成完整 bundle 与逐文件 manifest、生成 tar.gz 和 SHA256，然后解压到含空格的新路径，以本地 HTTP 模型 fixture 验证真实命令写入与文件读取。Linux 执行安装器再验证安装入口，并验证原生工具；macOS 在临时 tap 安装本地同一归档，执行 `brew test` 和真实读写，再运行 release-profile 的 bundle 生命周期 soak。

`release-artifacts.py` 拒绝 dirty working tree 或非 release-profile 的 manifest。候选输出包括平台 tar.gz、manifest、SHA256 sidecar；macOS 另生成最终下载 URL 和真实归档 SHA256 的 `areal.rb`。不要手工编写占位 SHA256，也不要将 CI 候选发布为已验收正式版本。

## 发布步骤

1. 合并发布准备变更；确认选定提交的 Verify 与 Release bundles 验收通过，并检查当前版本、许可证和迁移说明。
2. 审阅两平台候选、Homebrew 测试和 Linux 安装日志，确认版本及支持范围。
3. 在固定提交创建 `v0.1.4` tag；tag 必须与 `areal --version` 一致。tag workflow 重建并验收两平台产物，全部通过后才创建 **draft** Release，不自动公开。
4. 下载 draft assets，核对 SHA256SUMS、manifest 中的 sourceRevision、profile 和平台；补齐 release notes（默认权限、依赖、旧超时配置移除、压缩默认值及缓存已知限制）。macOS 尚无 Developer ID/公证，不应标为已公证。
5. 明确批准后公开 draft。创建/更新 `areal-project/homebrew-tap` 的 `Formula/areal.rb`，内容来自该 Release 资产；先确认公开下载 URL 可用，再测试 `brew install areal-project/tap/areal`。
6. 在干净 Linux 上用公开地址安装并跑读写验收；记录发行 digest 与最终结果。后续版本重复本流程，不替换已公开版本的归档。

Release tag 与公开、tap 创建/更新是外部发布操作，应在产物审阅完成后执行。draft job 不覆盖已有 Release；失败重试前应先检查已存在的远端状态，避免替换已公开资产。GitHub Release 不是 Linux 容器镜像发布，此流程不推送镜像。

## 本地命令

```sh
make release
python3 scripts/package.py --profile release --output target/release-bundle/areal
python3 scripts/release-artifacts.py archive --bundle target/release-bundle/areal --output target/release-assets
python3 scripts/release-smoke.py --bundle target/release-bundle/areal
python3 -m unittest discover -s scripts/tests -p test_release.py
```

Homebrew formula 安装 `bin`、`libexec`、LICENSE 和 manifest，避免改变 Core 查找 helper 的相对路径。Linux 安装器将不同版本放在不同目录，只原子替换入口符号链接；用户配置与历史不由安装器维护。校验失败不得切换入口。

## GUI 发布

GUI 版本由 `clients/gui/package.json` 和 `clients/gui/app/package.json` 共同声明，与 Cargo/CLI 版本独立。发布地址统一为 `areal-project/AReaL-Harness`；版本 Release 使用 `gui-v<版本>` 标签，CLI 继续使用 `v<版本>`。GUI Release 不设为 GitHub Latest，避免改变 CLI 安装器的 Latest 语义。

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

在固定提交创建 `gui-v<版本>` 标签，以 draft 上传 ZIP、DMG、`latest-mac.yml`、脱敏 `release.json` 与 `SHA256SUMS`；回读摘要后公开，保持 `--latest=false`。先确认版本附件可下载，再更新 `gui-update-channel` 的清单；首次创建该频道时使用 prerelease。公开后核对完整字节、HTTP Range、清单大小及 SHA-512。版本附件不可覆盖；频道清单按已验收版本推进。此流程不发布 CLI 包，也不更新 Homebrew tap。

GUI 只支持 macOS arm64 更新，检查和下载由 Electron 持有，后台任务空闲并完成原生校验后才关闭 Core 并安装。公开附件与包内 smoke 不证明既有安装已经完成自动替换；旧安装到新版本的实际升级需要单独验收。其他仓库或旧测试频道的客户端不会自动迁移到本频道，需要手动安装首个正式 GUI 包。

`pnpm --dir clients/gui run test:update` 通过真实 Electron preload/IPC 验证下载错误可见与重试进度。设置 `AREAL_GUI_EXECUTABLE` 为候选包入口，并设置 `AREAL_GUI_UPDATE_BASELINE` 为较旧已签名 GUI 的入口，可额外验证候选包的原生配置、公开 ZIP 下载与 SHA-512 校验、Squirrel 原生准备和安全停止 Core。脚本只启动旧基线的隔离副本，借用候选配置，不修改签名资源；截获最终安装调用后退出，核对 Squirrel 自动替换的副本版本，不触碰原基线或用户安装。证据目录由脚本输出。
