**中文** | [English](agent-environment.en.md)

# Agent 工作环境与验证分层

本页说明 Agent（以及人）在云端容器里能验证到哪一步、哪些必须留到 Mac 上验收。产品处于前期 Beta，不支持降级。

## 准备环境

```bash
make agent-setup                      # 系统包、Node（版本见 .node-version）、依赖、Chromium、构建
AGENT_SETUP_SKIP_BUILD=1 make agent-setup   # 只装环境不构建
```

完成后 `target/agent-env.json` 记录本机具备的能力（`core-binary`、`gui-build`、`electron`、`browser`、`native-runtime`、`node-24` 等），测试清单按 `requires` 跳过缺能力的项，跳过会列出来，不算通过。

## 改动是不是你造成的

```bash
make baseline-diff BASE=origin/codex/one-protocol-integration CMD='cargo test -p areal-host --lib'
make baseline-diff BASE=... CMD='pnpm --dir clients/gui exec vp test run' PREPARE='make gui-install'
```

在基准提交和当前工作区各跑一遍，只列状态变化的用例。基准上本来就红的不算回归；只有“基准通过、现在失败”才让命令失败。基准工作区和产物在 `target/baseline*`，可复用、可直接删。

## 名字一致性

`make check-refs`（`make check-changed` 已包含）检查 package.json、Makefile、工作流里写到的文件是否存在，开发文档里反引号路径是否存在，以及 `scripts/`、`clients/gui/scripts/` 下每个脚本是否有入口。存量无入口脚本登记在 `scripts/check-references-baseline.json`，只减不增；给脚本接上入口或删除后运行 `python3 scripts/check-references.py --write`。

## 过渡代码

`make check-transitional`（`make check-changed` 已包含）要求产品代码里名字带 legacy / compat 的地方，前后三行内写一条“过渡：到 <版本> 删”的注释；注释里的版本不大于当前版本就报到期。存量未写期限的按文件登记在 `scripts/check-transitional-baseline.json`，每个文件只减不增。fallback 与 migration 不在检查内：前者多是普通默认值，后者包含 Store 的正式迁移。

## 体积

`make check-rust-size`（`make check-changed` 已包含）要求 Rust 产品代码单文件不超过 1500 行；存量超限的 27 个文件登记在 `scripts/check-rust-size-baseline.json`，不得超过登记行数，拆分后运行 `python3 scripts/check-rust-size.py --write` 收紧。GUI 各区域的行数预算由 `gui-health` 检查。

## 验证分层

| 层 | 在哪跑 | 命令 |
| --- | --- | --- |
| 单测、契约 | 云端与 Mac | `make check-changed`，`pnpm --dir clients/gui run test:<名字>` |
| 网页业务旅程 | 云端与 Mac | `pnpm --dir clients/gui run test:web-journeys` |
| 桌面业务旅程 | 云端（xvfb）与 Mac | `pnpm --dir clients/gui run test:ux-journeys` |
| 桌面壳能力 | 只在 Mac | 下文“Mac 验收清单” |

网页与桌面是同一份界面、同一套 Host 协议，业务旅程在网页上通过即可，不必在 Mac 上逐项再点。Linux 无显示服务时用 `xvfb-run` 包一层；浏览器下载不到时设 `AREAL_CHROMIUM`。

## 桌面壳能力清单

`clients/gui/packages/workbench/client/desktop-contract/shell-capabilities.cjs` 给 preload 暴露的每个成员、主进程自己处理的每条命令归类：

- `shell`：只有桌面能做的系统能力，网页不需要等价物。
- `transitional`：业务读写暂时走 IPC，网页那边已经走 Host。迁到 Host 后从清单删掉并把上限调低。

`clients/gui/scripts/shell-capabilities.test.cjs`（`test:health`）保证清单与 preload、命令表一致，`transitional` 只减不增。

## Mac 验收清单

云端无法覆盖、发版前在 Mac 上过一遍：

1. 签名与公证后的安装包能打开，`brew` 安装可用。
2. 钥匙串：模型凭据写入、读取、隔离身份互不干扰。
3. 自动更新：检查、下载、应用、失败后恢复资源。
4. 真实数据升级：用本机数据副本升级，项目、历史、Arena 配置都在。
5. 手机配对：扫码配对、中继连接、推送。
6. 电脑控制：辅助功能与录屏权限申请、授权后可用、撤销后提示。
7. 截图：快捷键、权限、截图进入对话。
8. 安装命令行工具、深链接打开、系统通知点击跳转。
