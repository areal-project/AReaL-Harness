[中文](skills.md) | **English**

# Skill discovery and reading

CLI, TUI, serve and direct Core share discovery rules. Connections to an existing service use its server-side catalog. Both discovered and explicitly deployed Skills, including Profile references, register metadata only and read current files on demand without content snapshots.

| Priority | Directory |
|---|---|
| 1 | `<workspace>/.agents/skills/<name>/SKILL.md` |
| 2 | `<workspace>/.claude/skills/<name>/SKILL.md` |
| 3 | `~/.agents/skills/<name>/SKILL.md` |
| 4 | `~/.claude/skills/<name>/SKILL.md` |

Exact directory names override whole Skills without merging resources or taking identity from frontmatter name. Discovery examines direct children only, not parent projects. Trusted launch parameters determine workspace; RPC cwd cannot change it. User home is separate from AREAL_HARNESS_HOME.

## Metadata registration at startup

Each directory contains SKILL.md and may include references/scripts/assets. Discovery parses only bounded YAML frontmatter for name/description; without frontmatter, the directory name and first line provide these values. Headers allow 32 KiB and names 256 bytes; descriptions are truncated to 4096 bytes at a UTF-8 boundary. These limits do not apply to bodies or attachments. The initial model prompt includes names and bounded descriptions, not full instructions.

Attachments are not traversed, hashed or cached. The former 256 KiB per-resource, 2 MiB directory and attachment-count limits are removed. Discovery still permits 128 Skills and 256 entries per search directory. Invalid metadata, entrypoints or directory links skip that individual auto-discovered Skill with a warning naming its ID, path and cause, without falling back to a shadowed copy. Inaccessible or escaping search roots and discovery-count overflow still fail startup. Invalid explicit deployments fail clearly instead of silently omitting a requested Skill.

Skill-root symlinks may resolve into authorized project/global Skill roots; SKILL.md entrypoints cannot be symlinks. Trusted launchers may also inject parsed metadata; see the [desktop contract](../api/desktop.en.md#skills).

## Read current files on demand

`skill_list` returns names, descriptions and references without enumerating attachments; `resources` is null. Agents use `skill_read` to read SKILL.md when needed, then follow its relative resource paths. Each asynchronous read returns at most 8192 bytes with offset/nextOffset pagination; this page limit does not cap file size. Binary data is returned as base64, not automatically supplied as model image input. Bundled scripts do not run automatically.

Reads resolve each path component from the registered root directory descriptor, rejecting absolute paths, parent traversal, internal file/directory symlinks and special files. Invalid attachments fail that read without affecting other Skills. Body and attachment edits, additions and deletions affect subsequent reads; metadata indexes update on registration or restart. Pages are not guaranteed to share unchanged content; deployments needing consistency must provide read-only version directories.

## References and upgrades

Auto-discovered revisions use `metadata-<SHA-256>` and identify parsed metadata only; explicit deployments use their manifest revision. Skill id/revision pairs identify references without guaranteeing immutable bytes, so the same reference can read updated files. Profiles, Turns and queues fix selected Skill references without freezing attachments. Profile and Workflow definitions themselves remain immutable.

Default root sessions use the `areal-discovered-skills` Profile; CLI uses `claude-cli` and loads CLAUDE.md. Explicit Profiles expose only declared skills. Legacy CLI `claude-<name>` IDs changed to directory names while historical references remain. Unregistered historical Skill references are explicitly unavailable; to restore them, register their original ID/revision and directory in an explicit deployment manifest. Reads still return current files.

Legacy persisted skillHashes are ignored and are omitted on subsequent saves. Existing `{id,revision,root}` manifests remain valid without a loading-mode setting. See [desktop examples](../examples/desktop-api.en.md) for configuration and end-to-end checks.
