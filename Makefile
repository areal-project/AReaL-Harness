.DEFAULT_GOAL := help
SHELL := /bin/sh

# 传给 server 和 tui 子命令的附加参数；模型凭据沿用环境变量。
PREFIX ?= /usr/local
DESTDIR ?=

ARGS ?=
CI_BASE ?=
PYTHON_SOURCES := scripts tests
WORKGROUP_ENV = AREAL_WORKGROUP_RUNTIME="$(CURDIR)/target/debug/areal-runtime" AREAL_WORKGROUP_HELPER="$(CURDIR)/target/debug/areal-runtime-fs"

# Make 将 -- 后的单词视为目标；附加参数统一通过 ARGS 传递。
ifneq (,$(filter --%,$(MAKECMDGOALS)))
$(error Make 不透传 -- 后的参数。请使用 make tui ARGS='--prompt hello' 或直接运行 target/debug/areal --prompt hello)
endif

.PHONY: help fetch build release check fmt fmt-check lint test test-core \
	test-protocol test-concurrency verify smoke server tui schemas docs clean \
	capacity capacity-primitives capacity-core perf runtime test-runtime runtime-smoke verify-runtime git-auth-smoke \
	cordis-pin update-cordis sdk-test harness harness-smoke verify-harness \
	setup setup-node sdk-build script-test launcher-test workgroup-smoke unified-execution-smoke delegation-permissions-smoke capacity-workgroup local-service-smoke upgrade-smoke tui-upgrade-smoke \
	verify-native integration-boundaries ci-preflight ci-gui-static ci-gui-health \
	ci-gui-portable ci-core-contracts workflow-lint hooks-install check-changed

help: ## 显示常用操作（默认目标）
	@printf '%s\n' '用法：make <target> [ARGS="..."]' ''
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf '%s\n' '' "参数示例：make tui ARGS='--resume THREAD_ID'" "交互式性能测试：make perf"

setup: fetch setup-node ## 安装锁定的格式工具和两套 SDK 开发依赖
	uv sync --locked --only-group dev

setup-node: ## 安装原生 smoke 和两套 SDK 所需的锁定 Node 依赖
	npm ci --ignore-scripts
	npm --prefix runtime/sdk-typescript ci --ignore-scripts
	npm --prefix core/sdk-typescript ci --ignore-scripts

fetch: ## 下载 Cargo.lock 中的依赖
	cargo fetch --locked

build: ## 构建整个 workspace（debug）
	python3 scripts/prepare-runtime-shell.py --profile debug
	cargo build --locked --workspace
	python3 scripts/verification.py record-core --profile debug

release: ## 构建整个 workspace（release）
	python3 scripts/prepare-runtime-shell.py --profile release
	cargo build --locked --workspace --release
	python3 scripts/verification.py record-core --profile release

check: ## 类型检查整个 workspace 和测试目标
	cargo check --locked --workspace --all-targets

fmt: ## 格式化 Rust、TypeScript/JavaScript 和 Python
	cargo fmt --all
	uv run --locked --only-group dev ruff format $(PYTHON_SOURCES)
	npm run format

fmt-check: ## 检查各语言格式，不修改文件
	cargo fmt --all -- --check
	uv run --locked --only-group dev ruff format --check $(PYTHON_SOURCES)
	npm run format:check

lint: ## Rust / Python 静态检查和 Web 语法检查
	cargo clippy --locked --workspace --all-targets -- -D warnings
	uv run --locked --only-group dev ruff check $(PYTHON_SOURCES)
	node --check clients/web/app.js

test: build ## 构建匹配 Runtime 后运行 workspace 测试（不含显式容量测试）
	AREAL_TEST_BIN_DIR="$${AREAL_TEST_BIN_DIR:-$(CURDIR)/target/debug}" cargo test --locked --workspace --no-fail-fast $(CARGO_TEST_ARGS)

test-core: ## 运行 Core 模型、会话和并发测试
	cargo test --locked -p areal-engine

test-protocol: ## 运行 app-server 契约与连接测试
	cargo test --locked -p areal-app-server

test-concurrency: ## 运行并发原语行为测试
	cargo test --locked -p areal-engine --test concurrency

cordis-pin: ## 核对 Cordis 的 Git 来源、lockfile 和 pins.json
	python3 scripts/cordis-pin.py

update-cordis: ## 更新 Cordis main 并同步 pin；随后运行 verify 与 verify-runtime
	cargo update -p cordis-rs
	python3 scripts/cordis-pin.py --write

test-runtime: cordis-pin ## Runtime 组件、权限、去重、撤销竞态与私有传输测试
	python3 scripts/prepare-runtime-shell.py --profile debug
	cargo test --locked -p areal-runtime-protocol -p areal-runtime-client -p areal-runtime-fs -p areal-runtime-supervisor -p areal-runtime-exec-native -p areal-runtime

runtime: ## 启动私有 stdio Runtime；ARGS 指定 --workspace
	python3 scripts/prepare-runtime-shell.py --profile debug
	cargo build --locked -p areal-runtime-exec-native --bin areal-runtime-reaper
	cargo run --locked -p areal-runtime -- $(ARGS)

runtime-smoke: cordis-pin build ## 构建 Runtime 并验证原生执行后端
	python3 scripts/runtime-smoke.py $(ARGS)
	python3 scripts/runtime-fs-smoke.py $(ARGS)

verify-runtime: ## 顺序运行 Runtime 行为测试和真实 sandbox 验收
	$(MAKE) test-runtime
	$(MAKE) runtime-smoke

verify: ## 常规验收：格式、静态检查、Rust/SDK/Python 测试与 TUI 冒烟
	$(MAKE) cordis-pin
	$(MAKE) -j2 fmt-check sdk-test script-test
	$(MAKE) lint desktop-schema-check
	$(MAKE) test
	$(MAKE) launcher-test smoke

workflow-lint: ## 校验 GitHub Actions workflow
	python3 scripts/check-workflows.py

hooks-install: ## 显式安装仓库的推送前门禁
	python3 scripts/git-hooks.py install --base "$(CI_BASE)"

check-changed: ## 受影响快检加失败专项；显式 CI_BASE，ARGS=--plan 仅输出计划
	python3 scripts/check-changed.py --base "$(CI_BASE)" $(ARGS)

ci-gui-static: ## 共享计划的 GUI 提交前静态、类型、生产构建与预算检查
	@test -n "$(CI_BASE)" || { echo 'CI_BASE is required' >&2; exit 1; }
	python3 scripts/ci-preflight.py --base "$(CI_BASE)" --groups gui-portable --phase commit

ci-gui-health: ## 无依赖安装的 GUI 健康合同与基线检查
	@set -eu; \
	test -n "$(CI_BASE)" || { echo 'CI_BASE is required' >&2; exit 1; }; \
	base="$$(git merge-base "$(CI_BASE)" HEAD)"; \
	unset AREAL_DESIGN_BASE; \
	mkdir -p target/ci/gui; \
	node --test clients/gui/scripts/gui-health.test.mjs clients/gui/scripts/design-system-maturity.test.mjs; \
	if git cat-file -e "$$base:clients/gui/health-baseline.json" 2>/dev/null; then \
		node clients/gui/scripts/gui-health.mjs --check --base="$$base"; \
	else \
		node clients/gui/scripts/gui-health.mjs --check; \
	fi; \
	node clients/gui/scripts/gui-health.mjs > target/ci/gui/health.json

ci-gui-portable: ## 共享计划的 portable 全集；缺能力明确阻塞
	@test -n "$(CI_BASE)" || { echo 'CI_BASE is required' >&2; exit 1; }
	python3 scripts/ci-preflight.py --base "$(CI_BASE)" --groups gui-portable

ci-core-contracts: ## 构建匹配输入并执行全部 Core 合同；固定 Core 必须哈希匹配
	@test -n "$(CI_BASE)" || { echo 'CI_BASE is required' >&2; exit 1; }
	python3 scripts/ci-preflight.py --base "$(CI_BASE)" --groups core-contracts --with-dependencies

ci-preflight: ## 按需完整本机验收与逐阶段报告；显式 CI_BASE，不替代完整 CI
	@test -n "$(CI_BASE)" || { echo 'CI_BASE is required' >&2; exit 1; }
	python3 scripts/ci-preflight.py --base "$(CI_BASE)"

sdk-build: ## 编译两套 TypeScript SDK
	npm --prefix runtime/sdk-typescript run build
	npm --prefix core/sdk-typescript run build

sdk-test: ## 编译两套 SDK 并验证 Runtime 与插件行为
	npm --prefix runtime/sdk-typescript test
	npm --prefix core/sdk-typescript test

integration-boundaries: ## 检查独立构建、发行与产品代码不依赖可选平台适配器
	python3 scripts/check-integration-boundaries.py

launcher-test: build ## 构建后验证真实 Rust launcher；缺二进制必须失败
	python3 -m unittest discover -s scripts/launcher-tests

script-test: integration-boundaries ## 无需产品二进制的脚本、Web 投影、perf 与文档离线回归
	python3 scripts/check-docs.py
	node --test scripts/web-progress.test.mjs
	node --test scripts/local-service-wait.test.mjs
	node --test clients/gui/scripts/smoke-deadline.test.mjs
	node --test clients/gui/scripts/update.test.cjs
	python3 -m unittest discover -s scripts/tests
	python3 tests/perf/perf.py self-test

harness: ## 通过可信独立启动器启动工具 Harness；ARGS 指定工作区与数据目录
	python3 scripts/launch.py $(ARGS)

harness-smoke: build sdk-build ## 原生 SDK 与完整读改测试/强杀恢复
	python3 scripts/native-tools-smoke.py --bin-dir target/debug
	python3 scripts/native-python-smoke.py --bin-dir target/debug
	python3 scripts/runtime-sdk-smoke.py
	node scripts/harness-smoke.mjs
	node scripts/workgroup-smoke.mjs
	node scripts/unified-execution-smoke.mjs
	node scripts/delegation-permissions-smoke.mjs
	node scripts/plugin-smoke.mjs
	node scripts/permissions-smoke.mjs
	node scripts/permission-modes-smoke.mjs
	node scripts/permission-presets-smoke.mjs
	node scripts/git-auth-smoke.mjs
	python3 scripts/tui-local-smoke.py
	node scripts/local-service-smoke.mjs

unified-execution-smoke: build ## 真实 Runtime 的统一委派、组合交付、取消和恢复回归
	node scripts/unified-execution-smoke.mjs

delegation-permissions-smoke: build ## 验证只读强约束、不可用准入与继承权限的读取协作
	node scripts/delegation-permissions-smoke.mjs

local-service-smoke: build ## 验证共享服务、多个窗口与宿主故障恢复
	node scripts/local-service-smoke.mjs

git-auth-smoke: build ## 验证共享服务的 Git 身份、SSH agent 与 HTTPS 认证及失败保护
	node scripts/git-auth-smoke.mjs

upgrade-smoke: ## 构建真实 CLI 并隔离验证升级、旧版本保留与 Homebrew 保护
	cargo build --locked -p areal-cli
	uv run --locked --only-group dev python scripts/upgrade-smoke.py $(ARGS)

tui-upgrade-smoke: ## 用两套固定真实产物验证新旧 TUI 共存与后台换代保护
	uv run --locked --only-group dev python scripts/tui-upgrade-smoke.py $(ARGS)

workgroup-smoke: build ## 真实 Runtime 的 Workgroup 写入、组合、期限与故障结算回归
	$(WORKGROUP_ENV) cargo test --locked -p areal-engine --test workgroup real_core_workers_use_private_runtimes_and_final_combination_is_verified -- --ignored --exact
	$(WORKGROUP_ENV) cargo test --locked -p areal-engine --test workgroup real_verification_inherits_the_configured_runtime_command_deadline -- --ignored --exact
	$(WORKGROUP_ENV) cargo test --locked -p areal-engine --test workgroup real_runtime_checkpoint_settles_writers_and_requires_independent_checks -- --ignored --exact

verify-harness: ## 全部常规与原生集成验收（容量测试单独运行）
	$(MAKE) verify
	$(MAKE) runtime-smoke harness-smoke examples-desktop-api workgroup-smoke

verify-native: build ## macOS 原生后端与 Harness 集成验收（通用回归由 Linux CI 执行）
	AREAL_TEST_BIN_DIR="$(CURDIR)/target/debug" cargo test --locked -p areal-engine --features native-tests --test provider_replay
	cargo test --locked -p areal-app-server --test side_workspace_read -- --ignored
	cargo test --locked -p areal-runtime-exec-native
	cargo test --locked -p areal-runtime --features native-tests --test native_transport
	$(MAKE) -j4 launcher-test runtime-smoke harness-smoke examples-desktop-api workgroup-smoke

smoke: build ## 构建后验证 TUI、HTTP/SSE、持久化、强杀恢复和异步轨迹补传
	node scripts/smoke.mjs
	node scripts/trajectory-smoke.mjs
	node scripts/trajectory-semantics-smoke.mjs

server: ## 构建并启动 Core；读取用户 TOML、环境变量和显式 ARGS
	cargo run --locked -p areal-cli -- app-server $(ARGS)

tui: ## 启动本地 Core + Runtime + TUI；--endpoint/--remote 连接已有服务
	python3 scripts/prepare-runtime-shell.py --profile debug
	cargo build --locked -p areal-runtime -p areal-runtime-fs -p areal-runtime-exec-native -p areal-cli
	cargo run --locked -p areal-cli -- $(ARGS)

schemas: ## 使用 codex-cli 0.145.0 重新生成协议 schema
	node scripts/generate-schemas.mjs

docs: ## 生成 Rust API 文档至 target/doc
	cargo doc --locked --workspace --no-deps

clean: ## 清理 debug/release 构建产物，保留会话数据与 perf 报告
	cargo clean --profile dev
	cargo clean --profile release

# 单独分步调用，保证 make -j capacity 仍按顺序测量容量负载。
capacity: ## 顺序运行原语、Core 与多 Runtime 容量测试（可能耗时数分钟）
	$(MAKE) capacity-primitives
	$(MAKE) capacity-core
	$(MAKE) capacity-workgroup

capacity-primitives: ## 运行 20000 个异步任务的容量测试
	cargo test --locked -p areal-engine --test concurrency -- --ignored --nocapture

capacity-core: ## 运行 10000 个子 Agent 的持久化容量测试
	cargo test --locked -p areal-engine --test capacity -- --ignored --nocapture

capacity-workgroup: build ## 32 个真实 Runtime 的隔离写入与资源回收容量测试
	$(WORKGROUP_ENV) cargo test --locked -p areal-engine --test workgroup thirty_two_real_runtimes_isolate_writes_and_settle_before_final_publication -- --ignored --exact

perf: ## 交互式运行 Docker E2E/perf 工作流
	./scripts/perf interactive

.PHONY: examples-desktop-api desktop-schemas desktop-schema-check package
examples-desktop-api: build sdk-build ## 真实 Core/Runtime 的桌面 API 与 CLI 确定性验收
	node examples/desktop-api/run.mjs --all
	node examples/desktop-api/task-controls.mjs
	node examples/desktop-api/cli.mjs
	node examples/desktop-api/skills.mjs
	node examples/desktop-api/soak.mjs
	node examples/desktop-api/packaged-workgroup.mjs

desktop-schemas: ## 从 Rust 类型导出 AReaL 桌面契约
	python3 scripts/generate-desktop-schemas.py

desktop-schema-check: ## 临时生成并规范化比较三份桌面 schema，不修改已提交文件
	python3 scripts/desktop-schemas.py

package: release ## 生成 macOS arm64 / Linux x86_64 发行产物及完整性清单；ARGS 指定 --output
	python3 scripts/package.py $(ARGS)

.PHONY: install
install: release ## 构建并安装完整运行时；PREFIX 指定前缀，DESTDIR 指定打包暂存根
	python3 scripts/install-local.py --prefix "$(PREFIX)" --destdir "$(DESTDIR)"

.PHONY: gui-install gui-build gui gui-package gui-smoke
gui-install: ## 安装 GUI 的公开锁定依赖（需 pnpm）
	pnpm --dir clients/gui install --frozen-lockfile
	pnpm --dir clients/gui --filter @areal/gui-desktop exec install-electron
	pnpm --dir clients/gui --filter @areal/gui-desktop exec playwright-core install ffmpeg
gui-build: ## 同步锁定依赖并构建 GUI renderer
	pnpm --dir clients/gui install --frozen-lockfile
	pnpm --dir clients/gui build
gui: gui-build ## 启动桌面 GUI（先 make build）
	pnpm --dir clients/gui start
gui-package: gui-build ## 构建 macOS arm64 候选应用（先构建 Core，随后执行 sign:mac）
	pnpm --dir clients/gui package
gui-smoke: ## 隔离目录中验证真实 Electron/Core 和本地模型
	pnpm --dir clients/gui test:e2e

.PHONY: artifact-cleanup
artifact-cleanup: ## 预览旧 GUI/Rust 产物和中间缓存；默认保留最近 5 轮
	python3 scripts/artifact-cleanup.py $(ARGS)
