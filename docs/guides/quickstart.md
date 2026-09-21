**中文** | [English](quickstart.en.md)

# 快速开始

完整本地工具链需要 macOS；Linux 工具执行见[Docker 基准测试](../benchmarks/README.md)。先按[开发指南](../development/README.md)安装 Rust、Python、uv、Node.js 和 CMake。

## 构建与无密钥验证

克隆 [AReaL-Harness](https://github.com/areal-project/AReaL-Harness) 并进入仓库：

```sh
git clone https://github.com/areal-project/AReaL-Harness.git
cd AReaL-Harness
```

```sh
make setup
make build
make verify
# macOS 的完整原生集成验收，已包含 verify
make verify-harness
```

常规验证使用本地确定性模型，无需 API 密钥或内部服务。首次安装需要访问公开依赖源。

## 第一次模型会话

配置支持 SSE 和 function tools 的模型服务；endpoint 是完整请求 URL：

```sh
export AREAL_HARNESS_MODEL_ENDPOINT='https://model.example.com/v1/chat/completions'
export AREAL_HARNESS_MODEL='your-model-id'
export AREAL_HARNESS_MODEL_PROTOCOL='chat-completions'
export AREAL_HARNESS_API_KEY_ENV='AREAL_API_KEY'
# 输入密钥后回车；Bash 和 Zsh 均可使用。
read -r -s AREAL_API_KEY
export AREAL_API_KEY
make tui ARGS='--prompt Describe the workspace files'
```

无认证的本地服务可省略凭据变量和读取命令。省略 `--prompt` 进入全屏 TUI；`Ctrl-C` 取消任务，`Ctrl-Q` 退出本地服务。模型配置与 Responses 示例见[配置](configuration.md)。

## 可写工作区与 Web

工作区必须位于可信二进制和 Core 数据目录之外：

```sh
mkdir -p ../areal-example-workspace
printf 'hello\n' > ../areal-example-workspace/hello.txt
make tui ARGS='--workspace ../areal-example-workspace --allow-write'
```

工具网络默认关闭，部署可显式使用 `--allow-network`；Core 的模型连接不受该工具权限控制。

```sh
python3 -I -S scripts/launch.py \
  --workspace ../areal-example-workspace --allow-write \
  --data-dir ../areal-example-state --listen 127.0.0.1:4500
```

打开 `http://127.0.0.1:4500/ui`，在登录页填写 `../areal-example-state/security/auth.json` 中的本地 token；该凭据文件不要提交。终端 `Ctrl-C` 关闭服务与受管任务。更多操作见[客户端指南](clients.md)。
