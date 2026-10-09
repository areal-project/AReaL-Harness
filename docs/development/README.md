**中文** | [English](README.en.md)

# 开发指南

先阅读[架构](../design/architecture.md)和[开发规范](../../AGENTS.md)。所有命令从仓库根目录执行。

## 环境

| 依赖 | 要求 |
|---|---|
| Rust | `rust-toolchain.toml` 固定 1.94.0，含 rustfmt / Clippy |
| Python / uv | 开发使用 Python 3.11+；uv 安装锁定工具。macOS 产品运行需要可用的 `/usr/bin/python3`（Xcode Command Line Tools）；Linux 产品启动无需 Python；独立安装与升级脚本需要 PATH 中的 Python 3.9+ |
| Node.js / npm | Node.js 22.19.0+；两套 SDK 与格式工具 |
| 编译工具 | Git、Bash、GNU Make 3.81+、C/C++ 编译器、CMake；macOS 需 Xcode Command Line Tools |
| 文件搜索 | Runtime 文件助手内置 ripgrep Rust 搜索库；`make build/release` 不依赖宿主 rg |
| 原生执行 | macOS `/usr/bin/sandbox-exec`；Linux `/usr/bin/bwrap` + Runtime seccomp；固定评测另用[受控 Docker profile](../benchmarks/README.md) |

```sh
make setup
make build
make verify
```

`setup` 安装锁定的 Cargo、npm 和 uv 依赖。模型 fixture 无需密钥。使用代理时保留已有 `NO_PROXY` 条目并加入 `127.0.0.1,localhost`，同时配置了 `no_proxy` 时也同步更新。

开发时，启动和服务控制统一使用 `target/debug/areal`，避免与 PATH 中的安装版混用：

```sh
make build
./target/debug/areal service restart
./target/debug/areal
```

仅二进制变化时，共享服务空闲会自动重启，无需每次手动操作。若报配置冲突，执行诊断中的完整重启命令；有后台任务时先等待结算，确需取消才加 `--cancel`。频繁切换开发版/安装版时，可给开发版指定独立的外部目录，例如 `--data-dir /tmp/areal-dev-state`，启动和重启都传入同一参数；该目录使用独立历史。服务兼容性见[本地服务契约](../api/local-service.md#实例兼容性与历史)。

## 验证入口

| 修改范围 | 命令 |
|---|---|
| 格式 | `make fmt` / `make fmt-check` |
| 静态检查 | `make lint` |
| Rust / SDK / 脚本 | `make test` / `make sdk-test` / `make script-test` |
| 常规回归 | `make verify` |
| 原生集成 | `make verify-harness`，包含常规回归 |
| CI 原生增量 | `make verify-native`，仅运行原生后端与 Harness 集成 smoke |
| 容量 | `make capacity`，独立运行 |
| 仅文档 | `python3 scripts/check-docs.py`，同时核对命令与实现 |

测试范围见[测试指南](testing.md)。附加参数使用 `make tui ARGS='--prompt hello'`。`make release` 输出至 `target/release`，`make docs` 生成 Rust API 文档。

项目使用 [Apache-2.0](../../LICENSE)。Cargo workspace 和 npm 包声明同一许可证；两套 SDK 携带 LICENSE，`scripts/package.py` 将许可证复制到桌面包并记录校验和。第三方材料保留原有许可与版权说明。

## 依赖与风格

Rust 使用 `--locked`，升级同时更新清单和锁文件；Cordis 还需同步 [pins.json](../../upstream/pins.json)，见[升级指南](cordis.md)。npm 使用 `npm ci --ignore-scripts`；Python 使用 `uv sync --locked --only-group dev`。不使用临时下载的全局格式工具。冻结的第三方题目与 oracle 不参与批量格式化。

Rust 使用 rustfmt/Clippy；TS/JS/CSS/HTML 使用锁定 Prettier；自有 Python 使用 Ruff。遵循 `.editorconfig`。新注释使用中文解释约束与原因；已有准确英文不机械翻译。

文档按[文档目录](../README.md)分类，同次修改更新中英文。README 只保留简介与导航；API 放在 `docs/api/`；历史结果放在 `docs/benchmarks/reports/`。移动页面同步修复引用。图表同步维护 draw.io 和 SVG/已有 PNG，遵循[图表规范](../design/STYLE_GUIDE.md)。

Homebrew/Linux 发行产物、安装验收与 draft 发布流程见[发行流程](releasing.md)。

## 桌面 GUI

GUI 使用独立 pnpm 11.7.0 workspace。运行 `make gui-install`、`make gui-build`、`make gui-smoke`；启动、打包与隔离配置见 [GUI 指南](../../clients/gui/README.md)。

`make setup-node` 仅安装锁定的 Node 开发依赖，供不运行格式检查的原生 CI 使用；本地完整开发仍使用 `make setup`。
