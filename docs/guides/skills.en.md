[中文](skills.md) | **English**

# Skill discovery and reading

CLI, TUI, serve and direct Core share discovery rules. Connections to an existing service use its server-side catalog. Both discovered and explicitly deployed Skills, including Profile references, register metadata only and read current files on demand. Discovery does not cache bodies; successfully loaded main bodies are retained as tool results in conversation history.

| Priority | Directory |
|---|---|
| 1 | `<workspace>/.agents/skills/<name>/SKILL.md` |
| 2 | `<workspace>/.claude/skills/<name>/SKILL.md` |
| 3 | `<workspace>/.codex/skills/<name>/SKILL.md` |
| 4 | `~/.agents/skills/<name>/SKILL.md` |
| 5 | `~/.claude/skills/<name>/SKILL.md` |
| 6 | `~/.codex/skills/<name>/SKILL.md` |

Exact directory names override whole Skills without merging resources or taking identity from frontmatter name. Discovery examines direct children only, not parent projects. Trusted launch parameters determine workspace; RPC cwd cannot change it. User home is separate from AREAL_HARNESS_HOME.

## Metadata registration at startup

Each directory contains SKILL.md and may include references/scripts/assets. Discovery parses only bounded YAML frontmatter for name/description; without frontmatter, the directory name and first line provide these values. Headers allow 32 KiB and names 256 bytes; descriptions are truncated to 4096 bytes at a UTF-8 boundary. These limits do not apply to bodies or attachments. The initial model prompt includes names and bounded descriptions, not full instructions.

Attachments are not traversed, hashed or cached. The former 256 KiB per-resource, 2 MiB directory and attachment-count limits are removed. Automatic discovery permits up to 512 Skill names. Each search directory permits up to 512 raw entries, including ordinary files, hidden entries, and invalid directories. Invalid metadata, entrypoints or directory links skip that individual auto-discovered Skill with a warning naming its ID, path and cause, without falling back to a shadowed copy. Inaccessible or escaping search roots and discovery-count overflow still fail startup. Invalid explicit deployments fail clearly instead of silently omitting a requested Skill.

Each GUI and Core deployment permits up to 512 Skill version references. The GUI counts current enabled references and readable historical references after deduplication by `id/revision`, so historical versions consume the same quota. Overflow errors report the count and limit without truncating or collecting historical references. Deployment files remain limited to 1 MiB, with at most 64 Profiles per deployment and a 32 KiB total Skill description budget in model prompts. Explicit `selectedSkills` selections remain limited to 128 entries. These capacity limits do not change Profile, tool, approval, or file-read permissions.

Direct entries in user Skill search directories may be directory symlinks to another location; installing the link authorizes discovery of its target. Project Skill links remain constrained to the workspace and authorized roots. SKILL.md entrypoints cannot be symlinks. Trusted launchers may also inject parsed metadata; see the [desktop contract](../api/desktop.en.md#skills).

## Complete main-body loading and on-demand resources

`skill_list`, `skill_load`, and `skill_resource_read` normally require neither human nor model approval in Ask Permissions or Auto Review mode. Explicit deny/ask rules, Profile and session approval requirements, tool allowlists, Turn skill selection, plugin revocation, and resource-path checks still apply. Reading a skill grants no permission to run scripts, access the network, or read arbitrary host files.

`skill_list` returns names, descriptions, and references without enumerating attachments; `resources` is null. After selecting a skill, the model calls `skill_load {skill:{id,revision}}` to load the complete `SKILL.md` before applying its instructions. Progressive disclosure selects relevant files; it does not mean reading only the first page of the selected main instructions. Use `skill_resource_read` for supporting resources. Read required supporting instructions completely before acting; reference lookups may inspect only relevant ranges.

`skill_load` reads the complete UTF-8 main body through one open file and returns `{id,revision,resource:"SKILL.md",text,sizeBytes,sha256,complete:true}`. The entire response, including JSON escaping and metadata, must fit 64 KiB. Invalid or oversized bodies fail explicitly without a successful prefix. Keep applicability, core constraints, procedure, and resource navigation in `SKILL.md`; move detailed material to supporting files. The limit bounds this loading operation, not attachment size, and is not a recommended length.

Successful bodies bypass the ordinary 16 KiB tool preview and count in full toward tool-output and model-input budgets. Before the first solve response consumes them, compaction must preserve their complete content. Final request admission verifies the exact result; an input that cannot fit stops explicitly without enlarging the Turn budget or context window. After a successful model response, normal history compaction applies; reload instructions needed after compaction. Full delivery does not prove instruction compliance or permanent retention. `skill_load` is unavailable through `tool_program`'s selective-output interface.

`skill_list.loaded` retains its compatibility meaning: successfully accessed skill references, including pages and attachments, not complete main bodies. New `loadedMain` entries identify complete main-body receipts still present in the current history projection, as `{revision,sha256,sourceItemId}`. They do not acknowledge model comprehension or compliance, nor assert that current disk contents still match. Once compaction removes the complete receipt, the entry disappears.

`skill_resource_read` reads only referenced attachments and rejects `SKILL.md` and path aliases; the main body must be loaded completely through `skill_load`. Each page contains at most 8192 bytes; the model result budget can shorten pages with high JSON-escaping overhead, and `nextRead` remains the continuation cursor. Pages use `offset/nextOffset/eof`; `eof=true` does not prove coverage of earlier bytes. Non-final pages include an explicit `notice` and reusable `nextRead` arguments. Valid UTF-8 pages return only `text`; when a page ends inside a character, its complete prefix is returned and the next page starts at that character. Binary data, offsets inside a character, or explicit limits too small for one character retain `text:null` and `dataBase64`. Scripts are not executed and binary data is not automatically converted to image input.

Model pages include `resourceVersion`; `nextRead` carries `expectedVersion`. This metadata version binds the opened file's identity, size, and nanosecond timestamps. Ordinary writes or replacement reject continuation with `SKILL_RESOURCE_CHANGED`; restart at offset 0 rather than splice different versions. It is not a content hash or an immutable snapshot against adversarial concurrent writes. Use read-only version directories or fixed plugin packages when strict consistency is required. Size or metadata changes detected during a read also fail explicitly.

Public `areal/skill/read` and Rust `read_skill` retain byte pagination: maxBytes is 1–8192, with `dataBase64`, decodable `text`, `sizeBytes`, `nextOffset`, and `eof`. Model continuation fields are not added, and consistency across public API pages is not guaranteed. Model UTF-8 alignment does not change public byte offsets.

Standalone reads reopen the registered canonical path, including replaced root directories or ancestors, rejecting newly introduced symlinks along that path. Plugins read the fixed installed package and recheck revocation. Path checks reject escapes, internal file/directory symlinks, and special files; plugin-relative references remain inside the package. A bad attachment fails only its read. Metadata indexes refresh on registration or restart.

Compatibility: public `areal/skill/read`, Rust `read_skill`, and `loaded` remain available; model attachment pages use `skill_resource_read`. Explicit tool allowlists must include `skill_load` and `skill_resource_read` for the model entry points; they are not expanded automatically. Regression tests establish delivery, boundaries, permissions, and failure semantics. Continuation rates, instruction compliance, and overall task benefits require separate model evaluation.

## References and upgrades

Auto-discovered revisions use `metadata-<SHA-256>` and identify parsed metadata only; explicit deployments use their manifest revision. Skill id/revision pairs identify references without guaranteeing immutable bytes, so the same reference can read updated files. Profiles, Turns and queues fix selected Skill references without freezing attachments. Profile and Workflow definitions themselves remain immutable.

Default root sessions use the `areal-discovered-skills` Profile; CLI uses `claude-cli` and loads CLAUDE.md. Explicit Profiles expose only declared skills. Legacy CLI `claude-<name>` IDs changed to directory names while historical references remain. Unregistered historical Skill references are explicitly unavailable; to restore them, register their original ID/revision and directory in an explicit deployment manifest. Reads still return current files.

Web and TUI provide a Skill picker through `/skills`, with `/skill NAME` for direct selection. A selection is persisted as `selectedSkills` in the thread configuration and applies to later Turns; when no override is set, the Profile's complete Skill set remains active.

Legacy persisted skillHashes are ignored and are omitted on subsequent saves. Existing `{id,revision,root}` manifests remain valid without a loading-mode setting. See [desktop examples](../examples/desktop-api.en.md) for configuration and end-to-end checks.
