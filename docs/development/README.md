**中文** | [English](README.en.md)

# 开发指南

先阅读[架构](../design/architecture.md)和[开发规范](../../AGENTS.md)。所有命令从仓库根目录执行。

## 环境

| 依赖 | 要求 |
|---|---|
| Rust | `rust-toolchain.toml` 固定 1.94.0，含 rustfmt / Clippy |
| Python / uv | 开发使用 Python 3.11+；uv 安装锁定工具。产品 launcher 使用可信系统 Python 3.9+ 和标准库 |
| Node.js / npm | Node.js 22.19.0+；两套 SDK 与格式工具 |
| 编译工具 | Git、Bash、GNU Make 3.81+、C/C++ 编译器、CMake；macOS 需 Xcode Command Line Tools |
| 文件搜索 | ripgrep（`rg`），供 `search_files` 和对应回归使用 |
| 原生执行 | macOS `/usr/bin/sandbox-exec`；Linux 使用[受控 Docker profile](../benchmarks/README.md) |

```sh
make setup
make build
make verify
```

`setup` 安装锁定的 Cargo、npm 和 uv 依赖。模型 fixture 无需密钥。使用代理时保留已有 `NO_PROXY` 条目并加入 `127.0.0.1,localhost`，同时配置了 `no_proxy` 时也同步更新。

## 验证入口

| 修改范围 | 命令 |
|---|---|
| 格式 | `make fmt` / `make fmt-check` |
| 静态检查 | `make lint` |
| Rust / SDK / 脚本 | `make test` / `make sdk-test` / `make script-test` |
| 常规回归 | `make verify` |
| 原生集成 | `make verify-harness`，包含常规回归 |
| 容量 | `make capacity`，独立运行 |
| 仅文档 | `python3 scripts/check-docs.py`，同时核对命令与实现 |

测试范围见[测试指南](testing.md)。附加参数使用 `make tui ARGS='--prompt hello'`。`make release` 输出至 `target/release`，`make docs` 生成 Rust API 文档。

项目使用 [Apache-2.0](../../LICENSE)。Cargo workspace 和 npm 包声明同一许可证；两套 SDK 携带 LICENSE，`scripts/package.py` 将许可证复制到桌面包并记录校验和。第三方材料保留原有许可与版权说明。

## 依赖与风格

Rust 使用 `--locked`，升级同时更新清单和锁文件；Cordis 还需同步 [pins.json](../../upstream/pins.json)，见[升级指南](cordis.md)。npm 使用 `npm ci --ignore-scripts`；Python 使用 `uv sync --locked --only-group dev`。不使用临时下载的全局格式工具。冻结的第三方题目与 oracle 不参与批量格式化。

Rust 使用 rustfmt/Clippy；TS/JS/CSS/HTML 使用锁定 Prettier；自有 Python 使用 Ruff。遵循 `.editorconfig`。新注释使用中文解释约束与原因；已有准确英文不机械翻译。

文档按[文档目录](../README.md)分类，同次修改更新中英文。README 只保留简介与导航；API 放在 `docs/api/`；历史结果放在 `docs/benchmarks/reports/`。移动页面同步修复引用。图表同步维护 draw.io 和 SVG/已有 PNG，遵循[图表规范](../design/STYLE_GUIDE.md)。
