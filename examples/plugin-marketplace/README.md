[中文说明](README.zh-CN.md)

# Install the example marketplace plugins

In the plugin workspace, add this directory as a local marketplace. Open the Personal marketplace, select an adapter, preview its source, review the digest, and install it into the selected project. Open its Skill and choose Try to stage an ordinary chat draft. Send starts execution.

The browser and computer packages contain original AReaL Skill guidance. Their versioned `extensions.org.areal.hostRequirements` metadata declares the existing `browser_v1` or `computer_v1` host tool. Installation runs no scripts and starts no provider. The packages contain no model configuration, credentials, copied vendor Skill bodies, or bundled native executable.

Host capability readiness means that the required tool is deployed for the selected project. Computer control also needs enablement and the relevant OS grants. A ready tool does not imply that the operating system has granted access.

Use the existing **Create Skill** entry for the bundled official Skill Creator. These examples do not duplicate that source.

## Install the official Heptabase plugin

Select **Heptabase** in this marketplace, resolve and preview its source, review the digest, and install it into the selected project. The catalog uses the original [Heptabase plugin repository](https://github.com/heptameta/heptabase-agent-plugins), with `plugins/heptabase` pinned to commit `7cae4b5988bb4a2875e7ba9ea3f9eec12c644826` and plugin version `0.2.0`.

The source retains the upstream portable `plugin.json`, `mcp.json`, Skills, license, and Codex overlay with its `.app.json` registration. AReaL downloads the original package through the Git source flow. The Heptabase App ID currently has no AReaL Connector mapping, and its MCP declaration does not explicitly declare OAuth. This integration verifies installation of the original package. Account authorization and real tool calls are not yet supported.

You can also add `https://github.com/heptameta/heptabase-agent-plugins.git` as a Git marketplace at the same commit. Select Heptabase from that marketplace and follow the same preview and installation steps.

## Verify the local adapters

From the repository root, run the isolated source acceptance suite with an explicitly deployed Core binary:

```sh
AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/plugin-ecosystem-smoke.mjs
```

The suite uses a deterministic loopback model and a controlled local browser page. It records GUI installation, selected Skill content at the model boundary, Core tool results, browser effects, disabled computer admission, and the existing official Creator Runtime flow. It does not run physical native input, real providers, or installed packages. The manifest lists stale reference and UNKNOWN scenarios that this combined path does not cover.
