# Install the local AReaL adapters

In the plugin workspace, add this directory as a local marketplace. Open the Personal marketplace, select an adapter, preview its source, review the digest, and install it into the selected project. Open its Skill and choose Try to stage an ordinary chat draft. Send starts execution.

The browser and computer packages contain original AReaL Skill guidance. Their versioned `extensions.org.areal.hostRequirements` metadata declares the existing `browser_v1` or `computer_v1` host tool. Installation runs no scripts and starts no provider. The packages contain no model configuration, credentials, copied vendor Skill bodies, or bundled native executable.

Host capability readiness means that the required tool is deployed for the selected project. Computer control also needs enablement and the relevant OS grants. A ready tool does not imply that the operating system has granted access.

Use the existing **Create Skill** entry for the bundled official Skill Creator. These examples do not duplicate that source.

From the repository root, run the isolated source acceptance suite with an explicitly deployed Core binary:

```sh
AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/plugin-ecosystem-smoke.mjs
```

The suite uses a deterministic loopback model and a controlled local browser page. It records GUI installation, selected Skill content at the model boundary, Core tool results, browser effects, disabled computer admission, and the existing official Creator Runtime flow. It does not run physical native input, real providers, or installed packages. The manifest lists stale reference and UNKNOWN scenarios that this combined path does not cover.

[中文说明](README.zh-CN.md)
