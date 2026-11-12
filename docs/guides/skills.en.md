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

Skill-root symlinks may resolve into authorized project/global Skill roots; SKILL.md entrypoints cannot be symlinks. Trusted launchers may also inject parsed metadata; see the [desktop contract](../api/desktop.en.md#skills).

## Complete main-body loading and on-demand resources

`skill_list` and `skill_load` normally require neither human nor model approval. Attachments use the existing read-only `read_file` and `fs_read` tools with their ordinary permission rules. Explicit deny/ask rules, Profile and session approval requirements, tool allowlists, Turn Skill selection and plugin revocation still apply. Reading a Skill grants no permission to run scripts, access the network, or read arbitrary host files.

`skill_list` returns names, descriptions and references without enumerating attachments; `resources` is null and `resourceRoot` is the controlled `areal://skill/<id>/<revision>` prefix. After selecting a Skill, call `skill_load {skill:{id,revision}}` to load the complete `SKILL.md` before applying its instructions. Append an attachment path to `resourceRoot`: use `read_file` for text with line/column pagination and `fs_read` for binary or raw bytes. Core resolves these URIs, binding reads to the selected Skill in the current Turn; they are read-only, and ordinary reads of `SKILL.md` fail explicitly.

`skill_load` reads the complete UTF-8 main body through one open file and returns `{id,revision,resource:"SKILL.md",resourceRoot,sizeBytes,sha256,complete:true,text}`. The entire response, including JSON escaping and metadata, must fit 64 KiB; invalid or oversized bodies fail explicitly without a successful prefix. Keep applicability, core constraints, procedure and resource navigation in `SKILL.md`; move detailed material to supporting files. The limit bounds this loading operation, not attachment size, and is not a recommended length.

Successful bodies bypass the ordinary 16 KiB tool preview and count in full toward tool-output and model-input budgets. Before the first solve response consumes them, compaction must preserve their complete content. Final request admission verifies the exact result; an input that cannot fit stops explicitly without enlarging the Turn budget or context window. After a successful model response, normal history compaction applies; reload instructions needed after compaction. Full delivery does not prove instruction compliance or permanent retention. `skill_load` is unavailable through `tool_program`'s selective-output interface.

`skill_list.loaded` retains its compatibility meaning: successfully accessed Skill references, including main-body and attachment reads, not complete main bodies. New `loadedMain` entries identify complete main-body receipts still present in the current history projection, as `{revision,sha256,sourceItemId}`. They do not acknowledge model comprehension or compliance, nor assert that current disk contents still match. Once compaction removes the complete receipt, the entry disappears.

For Skill text attachments, ordinary `read_file` returns its standard line-page result: 1-based `offset`/`limit`/`column`, a full-content `sha256`, and `nextRead` for oversized lines; the normal bounded read-output budget still applies. `fs_read` returns at most 8192 bytes of `dataBase64`, the full-content hash, `size`, `nextOffset` and `eof`; `expectedSha256` can guard a continuation. Both tools reject the main-body alias, path escapes, symlinks and writes. After a resource changes, restart with the new hash or offset 0 rather than splicing different versions.

Public `areal/skill/read` and Rust `read_skill` retain their byte-pagination contract for clients and compatibility calls; they are not the model's default attachment entry point. Explicit model tool allowlists must include `skill_load`; existing allowlist rules for ordinary `read_file`/`fs_read` remain unchanged. Regression tests cover complete delivery, URI authorization, main-body rejection, ordinary read semantics and failure states. Instruction compliance and overall task benefit require separate model evaluation.

## References and upgrades

Auto-discovered revisions use `metadata-<SHA-256>` and identify parsed metadata only; explicit deployments use their manifest revision. Skill id/revision pairs identify references without guaranteeing immutable bytes, so the same reference can read updated files. Profiles, Turns and queues fix selected Skill references without freezing attachments. Profile and Workflow definitions themselves remain immutable.

Default root sessions use the `areal-discovered-skills` Profile; CLI uses `claude-cli` and loads CLAUDE.md. Explicit Profiles expose only declared skills. Legacy CLI `claude-<name>` IDs changed to directory names while historical references remain. Unregistered historical Skill references are explicitly unavailable; to restore them, register their original ID/revision and directory in an explicit deployment manifest. Reads still return current files.

Web and TUI provide a Skill picker through `/skills`, with `/skill NAME` for direct selection. A selection is persisted as `selectedSkills` in the thread configuration and applies to later Turns; when no override is set, the Profile's complete Skill set remains active.

Legacy persisted skillHashes are ignored and are omitted on subsequent saves. Existing `{id,revision,root}` manifests remain valid without a loading-mode setting. See [desktop examples](../examples/desktop-api.en.md) for configuration and end-to-end checks.
