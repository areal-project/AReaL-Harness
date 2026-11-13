[中文](quickstart.md) | **English**

# Quickstart

The full local toolchain requires macOS. For Linux tool execution, see [Docker benchmarks](../benchmarks/README.en.md). Install Rust, Python, uv, Node.js and CMake using the [development guide](../development/README.en.md).

## Build and check without credentials

Clone [AReaL-Harness](https://github.com/areal-project/AReaL-Harness) and enter the repository:

```sh
git clone https://github.com/areal-project/AReaL-Harness.git
cd AReaL-Harness
```

```sh
make setup
make build
make verify
# macOS native integration checks; already includes verify
make verify-harness
```

Regular checks use a local deterministic model and need no API key or internal service. The initial dependency installation requires access to public registries.

## First model session

Configure a model service supporting SSE and function tools. The endpoint is a complete request URL:

```sh
export AREAL_HARNESS_MODEL_ENDPOINT='https://model.example.com/v1/chat/completions'
export AREAL_HARNESS_MODEL='your-model-id'
export AREAL_HARNESS_MODEL_PROTOCOL='chat-completions'
export AREAL_HARNESS_API_KEY_ENV='AREAL_API_KEY'
read -r -s AREAL_API_KEY
export AREAL_API_KEY
target/debug/areal exec 'Describe the workspace files'
```

The secret-reading command works in Bash and Zsh; type the key and press Enter. For an unauthenticated local service, omit credential variables and the read command. Run `target/debug/areal` for the fullscreen TUI; `Ctrl-C` cancels the task and `Ctrl-Q` closes the window while the shared service remains running. See [configuration](configuration.en.md) for Responses and file-based settings.

## Writable workspace and Web

Local launch defaults to YOLO, including writes outside the workspace and tool networking. Keep Core data outside the workspace:

```sh
mkdir -p ../areal-example-workspace
printf 'hello\n' > ../areal-example-workspace/hello.txt
target/debug/areal --workspace ../areal-example-workspace
```

To request approvals, set `ASK_PERMISSIONS=1` before launch or configure `[permissions] mode = "ASK_PERMISSIONS"`; see [permissions](configuration.en.md#permissions). TUI `/permissions` shows the effective policy. Existing shared services require explicit restart after permission changes.

Open the web interface:

```sh
target/debug/areal web
```

It opens the interface served by Host, the same one as the desktop app; a browser needs local approval the first time it connects. See the [client guide](clients.en.md) for more operations.
