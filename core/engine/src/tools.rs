use super::*;
use areal_protocol::{ToolExecution, ToolOutcome, ToolStatus};
use areal_runtime_client::Client;
use areal_runtime_protocol as rt;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use model::ToolCall;
use serde::Deserialize;
use std::path::PathBuf;

const MAX_RESULT: usize = 16 * 1024;
#[derive(Default)]
pub(crate) struct Handles {
    processes: BTreeMap<String, String>,
    cursors: BTreeMap<String, (String, String)>,
    versions: BTreeMap<String, (String, String)>,
    version_order: std::collections::VecDeque<String>,
    process_snapshots: BTreeMap<String, Value>,
    verification: BTreeMap<String, String>,
    pub(crate) pending_verifications: HashSet<String>,
}

fn short_handle(kind: char) -> String {
    // These are conveniences, never authorization capabilities. Runtime still
    // checks real process ownership and file CAS after Core resolves them.
    format!("{kind}{}", &uuid::Uuid::new_v4().simple().to_string()[..16])
}

impl Handles {
    fn resolve(&self, name: &str, args: &mut Value, runtime: &RuntimeConfig) -> anyhow::Result<()> {
        if matches!(name, "fs_list" | "search_files") && args.get("path").is_none() {
            args["path"] = json!(".");
        }
        for field in ["path", "cwd"] {
            if let Some(path) = args[field].as_str() {
                args[field] = json!(resource_uri(path, runtime)?);
            }
        }
        if matches!(name, "read_process" | "write_process" | "terminate_process") {
            if let Some(handle) = args["processId"].as_str().filter(|s| s.starts_with('p')) {
                args["processId"] =
                    json!(self.processes.get(handle).context(
                        "unknown or expired process alias; use an alias from this Turn"
                    )?);
            }
            if let Some(handle) = args["after"].as_str().filter(|s| s.starts_with('c')) {
                let (process, cursor) = self
                    .cursors
                    .get(handle)
                    .context("unknown or expired cursor alias; omit after to continue")?;
                anyhow::ensure!(
                    args["processId"] == *process,
                    "cursor belongs to another process"
                );
                args["after"] = json!(cursor);
            }
        }
        if let Some(handle) = args.get("fileVersion") {
            anyhow::ensure!(
                matches!(name, "fs_write" | "fs_apply_patch")
                    && args.get("expectedSha256").is_none(),
                "supply fileVersion or expectedSha256, never both"
            );
            let (path, hash) = self
                .versions
                .get(handle.as_str().context("fileVersion must be a string")?)
                .context("unknown or expired fileVersion; read the file again")?;
            anyhow::ensure!(
                *path == resource_uri(args["path"].as_str().context("path required")?, runtime)?,
                "fileVersion belongs to another path"
            );
            args.as_object_mut().unwrap().remove("fileVersion");
            args["expectedSha256"] = json!(hash);
        } else if matches!(name, "fs_write" | "fs_apply_patch")
            && args.get("expectedSha256").is_none()
        {
            let path = args["path"].as_str().context("path required")?;
            let observed = self
                .version_order
                .iter()
                .rev()
                .filter_map(|id| self.versions.get(id))
                .find(|(known_path, _)| known_path == path);
            if let Some((_, hash)) = observed {
                args["expectedSha256"] = json!(hash);
            } else if name == "fs_write" {
                // No known version only authorizes creation, never overwrite.
                args["expectedSha256"] = Value::Null;
            } else {
                anyhow::bail!(
                    "read_file this path before editing; its observed version is managed automatically. After a conflict, read again. Example: read_file({{\"path\":\"src/code.py\"}}), then fs_apply_patch({{\"path\":\"src/code.py\",\"oldText\":\"old\",\"newText\":\"new\"}})"
                );
            }
        }
        Ok(())
    }

    fn expose(&mut self, name: &str, args: &Value, value: &mut Value, runtime: &RuntimeConfig) {
        if let Some(process) = value["processId"].as_str().map(str::to_owned) {
            let alias = self
                .processes
                .iter()
                .find(|(_, p)| **p == process)
                .map(|(a, _)| a.clone())
                .unwrap_or_else(|| {
                    let alias = short_handle('p');
                    self.processes.insert(alias.clone(), process.clone());
                    alias
                });
            value["processId"] = json!(alias);
            if let Some(cursor) = value["nextCursor"].as_str().map(str::to_owned) {
                // One current cursor per process, not one allocation per poll.
                // An expired explicit cursor fails; omitting it resumes safely.
                self.cursors.retain(|_, (owner, _)| owner != &process);
                let alias = short_handle('c');
                self.cursors.insert(alias.clone(), (process, cursor));
                value["nextCursor"] = json!(alias);
            }
            let fields = [
                "processId",
                "state",
                "exitCode",
                "stopReason",
                "outputReadComplete",
                "nextCursor",
                "outputIntegrity",
                "commandStatus",
            ];
            let snapshot: serde_json::Map<_, _> = fields
                .into_iter()
                .filter_map(|k| value.get(k).map(|v| (k.to_owned(), v.clone())))
                .collect();
            self.process_snapshots
                .insert(alias, Value::Object(snapshot));
        }
        if matches!(
            name,
            "fs_read" | "read_file" | "fs_write" | "fs_create" | "fs_apply_patch"
        ) && let Some(hash) = value["sha256"].as_str().map(str::to_owned)
            && let Some(path) = args["path"]
                .as_str()
                .and_then(|s| resource_uri(s, runtime).ok())
        {
            let alias = short_handle('v');
            self.versions.insert(alias.clone(), (path.clone(), hash));
            self.version_order.push_back(alias.clone());
            while self.version_order.len() > 128 {
                self.versions
                    .remove(&self.version_order.pop_front().unwrap());
            }
            value["path"] = json!(path);
            value["fileVersion"] = json!(alias);
        }
    }

    fn snapshot(&self) -> Value {
        fn bounded(values: impl Iterator<Item = Value>) -> Value {
            let mut bytes = 0;
            let values: Vec<_> = values
                .take_while(|v| {
                    bytes += v.to_string().len();
                    bytes <= 5500
                })
                .collect();
            json!(values)
        }
        let mut paths = HashSet::new();
        let files = self.version_order.iter().rev().filter_map(|id| {
            let (path, _) = self.versions.get(id)?;
            paths
                .insert(path)
                .then(|| json!({"path":path,"fileVersion":id}))
        });
        json!({"processes":bounded(self.process_snapshots.values().cloned()),
            "files":bounded(files),"processCount":self.processes.len(),
            "retainedFileVersions":self.versions.len(),"observedOnly":true,
            "guidance":"Only this Turn's observed handles are valid. Process state is the last observation: read_process refreshes it. File versions may be stale after shell/external edits: Runtime CAS still checks. Lists are byte bounded; re-read omitted files. Handles expire at Turn completion/restart. An omitted after resumes the current process cursor."})
    }
}
mod agents;
mod extensions;
mod images;
mod navigation;
mod plugin_execution;
pub mod plugins;
pub(crate) mod registry;
pub(crate) use registry::Backend;
mod verification;
pub(crate) use registry::Registry;
pub use registry::{
    AgentToolsConfig, CommandTool, DynamicToolHost, HookDefinition, HookEvent, ToolExtensions,
    ToolPolicy,
};

#[derive(Clone)]
pub(crate) struct Bindings {
    pub registry: Registry,
    pub host: Option<Arc<dyn DynamicToolHost>>,
}
pub struct RuntimeConfig {
    pub client: Arc<Client>,
    pub workspace: PathBuf,
    pub writable: bool,
    /// Trusted temporary directory disjoint from the workspace. When present,
    /// commands receive TMPDIR and disable Python bytecode source pollution.
    pub command_scratch: Option<PathBuf>,
}

pub fn definitions() -> Vec<Value> {
    definitions_with_policy(&ToolPolicy::default())
}

fn definitions_with_policy(policy: &ToolPolicy) -> Vec<Value> {
    fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
        json!({"type":"function","function":{"name":name,"description":description,"parameters":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}})
    }
    let path = json!({"type":"string","description":"Workspace path, e.g. src/main.py, ., or workspace://repo/src/main.py. Absolute paths must be inside this workspace. No parent traversal or symlinks."});
    let process_id = json!({"type":"string","description":"Copy the complete opaque processId returned by run_command. Do not shorten, reconstruct or substitute a cursor."});
    let mut definitions = vec![
        tool(
            "task_state",
            "Inspect this Turn's authoritative process/file handles and owned agents after compaction or a stale-handle error. Reports bounded observations, not model-written notes; no workflow decisions or file mutations.",
            json!({}),
            &[],
        ),
        tool(
            "read_file",
            "Read a UTF-8 file with 1-based line offset/limit and line numbers. Returns fileVersion for conditional edits; follow nextLine when truncated. At most 8 MiB source and bounded output; use fs_read for an oversized single line.",
            json!({"path":path,"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1,"maximum":1000}}),
            &["path"],
        ),
        tool(
            "search_files",
            "Search with ripgrep regex inside a workspace path, returning file names, line numbers and nearby lines. Respects gitignore, does not follow symlinks. Invalid regex is an error; limited results require narrowing the path or pattern.",
            json!({"path":path,"pattern":{"type":"string"},"glob":{"type":"string"},"context":{"type":"integer","minimum":0,"maximum":10},"limit":{"type":"integer","minimum":1,"maximum":100}}),
            &["pattern"],
        ),
        tool(
            "image_read",
            "Read a PNG/JPEG/WebP image from the workspace or workspace://scratch and return actual visual content to the model. Optional crop uses source pixels; maxDimension defaults to 2048. Rejects symlinks, files over 8 MiB, and images over 32 megapixels.",
            json!({"path":path,"maxDimension":{"type":"integer","minimum":64,"maximum":4096},"crop":{"type":"object","properties":{"x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},"width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}},"required":["x","y","width","height"],"additionalProperties":false}}),
            &["path"],
        ),
        tool(
            "fs_read",
            "Read a regular file (maximum 8 MiB). Returns a chunk of at most 8192 bytes, eof/nextOffset, and fileVersion for conditional edits. Larger maxBytes requests are capped explicitly; follow nextOffset until eof.",
            json!({"path":path,"offset":{"type":"integer","minimum":0,"default":0},"maxBytes":{"type":"integer","minimum":1,"default":8192}}),
            &["path"],
        ),
        tool(
            "fs_list",
            "List a directory (path defaults to workspace root, limit to 100). Continue with nextCursor as after; omit after for the first page. Symlink entries are reported without following them.",
            json!({"path":path,"after":{"type":["string","null"]},"limit":{"type":"integer","minimum":1,"maximum":256}}),
            &[],
        ),
        tool(
            "fs_stat",
            "Inspect one directory entry without following a symlink.",
            json!({"path":path}),
            &["path"],
        ),
        tool(
            "fs_create",
            "Create a new UTF-8 file up to 64 KiB (also subject to the total tool argument budget). Fails if the path already exists; never overwrites. Use fs_read then fs_apply_patch or fs_write to edit an existing file.",
            json!({"path":path,"text":{"type":"string"}}),
            &["path", "text"],
        ),
        tool(
            "fs_write",
            "Create or replace a UTF-8 file up to 64 KiB. The last version observed by read_file/fs_read or a successful edit is used automatically. Without a read, only creation is allowed. Read again after a conflict. Explicit fileVersion/expectedSha256 remain supported; never supply both. Parent directories must exist (run_command command=mkdir -p ...).",
            json!({"path":path,"text":{"type":"string"},"fileVersion":{"type":"string"},"expectedSha256":{"type":["string","null"],"pattern":"^[0-9a-f]{64}$"}}),
            &["path", "text"],
        ),
        tool(
            "fs_apply_patch",
            "Replace exactly one matching text region in a UTF-8 file after read_file/fs_read. Version checking is automatic; no token copying is needed. Ambiguous or stale content fails without overwriting; read again after a conflict. Explicit fileVersion/expectedSha256 remain supported.",
            json!({"path":path,"oldText":{"type":"string"},"newText":{"type":"string"},"fileVersion":{"type":"string"},"expectedSha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}}),
            &["path", "oldText", "newText"],
        ),
        tool(
            "verify_command",
            "Run a test/build executable directly (no shell pipelines). Saves the complete output and a receipt in task scratch, with actual exit code and before/after source fingerprint. For example argv=[\"python\",\"-m\",\"pytest\",\"tests/test_feature.py\"]. Read the returned process until it exits; later source edits invalidate the receipt. Exit zero alone does not prove the task correct.",
            json!({"argv":{"type":"array","items":{"type":"string"},"minItems":1},"cwd":path,"timeoutMs":{"type":"integer","minimum":1},"yieldMs":{"type":"integer","minimum":0}}),
            &["argv"],
        ),
        tool(
            "run_command",
            &format!(
                "Run command text with bash -o pipefail -c, or pass argv for a direct executable. Supply exactly one of command/argv; argv does not interpret shell operators. Collects output until completion or the wait budget, up to yieldMs (default {}, or {} for PTY). Use yieldMs=0 for independent work, then read_process. Inspect commandStatus and outputReadComplete. Turn completion reclaims commands.",
                policy.command_wait_ms, policy.pty_wait_ms
            ),
            json!({"command":{"type":"string","minLength":1},"argv":{"type":"array","items":{"type":"string"},"minItems":1},"cwd":path,"timeoutMs":{"type":"integer","minimum":1},"yieldMs":{"type":"integer","minimum":0},"tty":{"type":"boolean","default":false}}),
            &[],
        ),
        tool(
            "read_process",
            &format!(
                "Collect output until completion or waitMs (default {}; 0 returns immediately). Output pages may return earlier. No fixed wait ceiling; Turn deadline and cancellation still apply. Omit after to resume this Turn's last returned cursor. Explicit null starts at the earliest retained output. Check state, exitCode and stopReason; gap means older output was lost.",
                policy.read_wait_ms
            ),
            json!({"processId":process_id,"after":{"type":["string","null"]},"waitMs":{"type":"integer","minimum":0,"default":policy.read_wait_ms}}),
            &["processId"],
        ),
        tool(
            "write_process",
            "Write UTF-8 input to a managed command in this Turn. Include newline to submit a line; a PTY also accepts control characters. Does not wait for command completion.",
            json!({"processId":process_id,"text":{"type":"string"}}),
            &["processId", "text"],
        ),
        tool(
            "terminate_process",
            "Terminate a managed command in this Turn and wait for its resources to be reclaimed.",
            json!({"processId":process_id}),
            &["processId"],
        ),
    ];
    for definition in &mut definitions {
        let f = &mut definition["function"];
        if f["name"] == "run_command" {
            f["parameters"]["oneOf"] = json!([{"required":["command"]},{"required":["argv"]}]);
        }
    }
    definitions
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateFile {
    path: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteFile {
    path: String,
    text: String,
    expected_sha256: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Command {
    argv: Vec<String>,
    cwd: String,
    timeout_ms: u64,
    #[serde(default, deserialize_with = "present_wait")]
    yield_ms: Option<u64>,
    #[serde(default)]
    tty: bool,
}
// Optional means the field may be absent; an explicit null is not an integer.
fn present_wait<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<Option<u64>, D::Error> {
    u64::deserialize(input).map(Some)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadProcess {
    process_id: String,
    after: Option<String>,
    wait_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteProcess {
    process_id: String,
    text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessId {
    process_id: String,
}
enum Request {
    File(rt::FileCommand),
    Command(Command),
    ReadProcess(ReadProcess),
    WriteProcess(WriteProcess),
    TerminateProcess(ProcessId),
}
#[cfg(test)]
fn request(
    call: &ToolCall,
    workspace: &std::path::Path,
    epoch: &str,
    cursors: &BTreeMap<String, String>,
) -> anyhow::Result<Request> {
    request_with_policy(call, workspace, epoch, cursors, &ToolPolicy::default())
}

fn request_with_policy(
    call: &ToolCall,
    workspace: &std::path::Path,
    epoch: &str,
    cursors: &BTreeMap<String, String>,
    policy: &ToolPolicy,
) -> anyhow::Result<Request> {
    let mut args: Value = serde_json::from_str(&call.arguments)?;
    anyhow::ensure!(
        args.is_object() && call.arguments.len() <= 64 * 1024,
        "tool arguments must be an object of at most 64 KiB"
    );
    for field in ["path", "cwd"] {
        if let Some(path) = args.get(field).and_then(Value::as_str) {
            args[field] = json!(workspace_uri(path, workspace)?);
        }
    }
    if call.name == "fs_read" {
        let fields = args.as_object_mut().unwrap();
        fields.entry("offset").or_insert(json!(0));
        fields.entry("maxBytes").or_insert(json!(8192));
        if let Some(bytes) = fields["maxBytes"].as_u64() {
            fields.insert("maxBytes".into(), json!(bytes.min(8192)));
        }
    }
    if call.name == "read_process" && args.get("waitMs").is_none() {
        args["waitMs"] = json!(policy.read_wait_ms);
    }
    if call.name == "read_process" && args.get("after").is_none() {
        args["after"] = json!(args["processId"].as_str().and_then(|id| cursors.get(id)));
    }
    if matches!(
        call.name.as_str(),
        "read_process" | "write_process" | "terminate_process"
    ) {
        let process = args["processId"]
            .as_str()
            .context("processId must be a string")?;
        let prefix = format!("{epoch}:process:");
        anyhow::ensure!(
            process
                .strip_prefix(&prefix)
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .is_some(),
            "invalid processId; copy the complete processId returned by run_command unchanged"
        );
        if call.name == "read_process" && !args["after"].is_null() {
            let prefix = format!("{process}/");
            anyhow::ensure!(
                args["after"]
                    .as_str()
                    .and_then(|cursor| cursor.strip_prefix(&prefix))
                    .and_then(|offset| offset.parse::<u64>().ok())
                    .is_some(),
                "invalid output cursor; copy the complete nextCursor for this process, or use null"
            );
        }
    }
    if matches!(call.name.as_str(), "run_command" | "verify_command") {
        let fields = args.as_object_mut().unwrap();
        if call.name == "run_command"
            && let Some(command) = fields.remove("command")
        {
            anyhow::ensure!(
                !fields.contains_key("argv"),
                "supply exactly one of command or argv"
            );
            let command = command.as_str().context("command must be text")?;
            anyhow::ensure!(
                !command.is_empty() && !command.contains('\0'),
                "command must be nonempty without NUL"
            );
            fields.insert(
                "argv".into(),
                json!(["/bin/bash", "-o", "pipefail", "-c", command]),
            );
        }
        fields.entry("cwd").or_insert(json!("workspace://repo"));
        fields.entry("timeoutMs").or_insert(json!(600_000));
        let command: Command = serde_json::from_value(args)?;
        anyhow::ensure!(
            !command.argv.is_empty(),
            "argv must contain at least one argument"
        );
        anyhow::ensure!(command.timeout_ms > 0, "invalid command time budget");
        return Ok(Request::Command(command));
    }
    if call.name == "read_process" {
        let read: ReadProcess = serde_json::from_value(args)?;
        return Ok(Request::ReadProcess(read));
    }
    if call.name == "write_process" {
        return Ok(Request::WriteProcess(serde_json::from_value(args)?));
    }
    if call.name == "terminate_process" {
        return Ok(Request::TerminateProcess(serde_json::from_value(args)?));
    }
    if call.name == "fs_create" {
        let args: CreateFile = serde_json::from_value(args)?;
        return Ok(Request::File(rt::FileCommand::Write {
            path: args.path,
            data_base64: STANDARD.encode(args.text),
            expected: rt::ExpectedFile::Absent,
        }));
    }
    if matches!(call.name.as_str(), "fs_write" | "fs_apply_patch")
        && let Some(Value::String(hash)) = args.get("expectedSha256")
    {
        anyhow::ensure!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "expectedSha256 must be the 64 lowercase hex characters from fs_read; fs_write creation requires explicit JSON null, not the string null"
        );
    }
    if call.name == "fs_write" {
        anyhow::ensure!(
            args.get("expectedSha256").is_some(),
            "fs_write requires an explicit expectedSha256 (null for creation)"
        );
        let args: WriteFile = serde_json::from_value(args)?;
        return Ok(Request::File(rt::FileCommand::Write {
            path: args.path,
            data_base64: STANDARD.encode(args.text),
            expected: match args.expected_sha256 {
                Some(value) => rt::ExpectedFile::Sha256 { value },
                None => rt::ExpectedFile::Absent,
            },
        }));
    }
    let kind = match call.name.as_str() {
        "fs_read" => "read",
        "fs_list" => "list",
        "fs_stat" => "stat",
        "fs_apply_patch" => "applyPatch",
        _ => anyhow::bail!("unknown tool: {}", call.name),
    };
    anyhow::ensure!(args.get("kind").is_none(), "unexpected kind argument");
    if call.name == "fs_list" {
        let object = args
            .as_object_mut()
            .context("arguments must be an object")?;
        object.entry("path").or_insert(json!("workspace://repo"));
        object.entry("after").or_insert(Value::Null);
        object.entry("limit").or_insert(json!(100));
    }
    args["kind"] = json!(kind);
    let command: rt::FileCommand = serde_json::from_value(args)?;
    match &command {
        rt::FileCommand::Read { max_bytes, .. } => {
            anyhow::ensure!((1..=8192).contains(max_bytes), "maxBytes must be 1..8192");
        }
        rt::FileCommand::List { limit, .. } => {
            anyhow::ensure!((1..=256).contains(limit), "limit must be 1..256");
        }
        _ => {}
    }
    Ok(Request::File(command))
}

impl Engine {
    pub(crate) async fn tool(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
        call: ToolCall,
        remaining: usize,
    ) -> anyhow::Result<usize> {
        let plugin_budget = if cell
            .bindings
            .read()
            .await
            .registry
            .get(&call.name)
            .is_ok_and(|entry| matches!(entry.backend, Backend::Plugin(_)))
        {
            plugins::MAX_JOURNAL
        } else {
            0
        };
        anyhow::ensure!(
            remaining >= call.arguments.len() * 2 + MAX_RESULT * 2 + 4096 + plugin_budget,
            "turn tool/output budget exhausted before execution"
        );
        let (sent, received) = tokio::sync::oneshot::channel();
        let engine = self.clone();
        let owned_cell = cell.clone();
        let token = cancel.clone();
        {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().unwrap();
            anyhow::ensure!(!active.sealed && !cancel.is_cancelled(), "cancelled");
            active.tools.spawn(async move {
                let result =
                    std::panic::AssertUnwindSafe(engine.tool_owned(&owned_cell, &token, call))
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|_| {
                            Err(anyhow::anyhow!(
                                "tool task panicked; outcome may be UNKNOWN"
                            ))
                        });
                let _ = sent.send(result);
            });
        }
        received.await?
    }
    async fn tool_owned(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
        cancel: &CancellationToken,
        call: ToolCall,
    ) -> anyhow::Result<usize> {
        let bindings = cell.bindings.read().await.clone();
        let entry = bindings.registry.get(&call.name);
        let coordination = entry
            .as_ref()
            .is_ok_and(|e| matches!(e.backend, Backend::Coordination | Backend::Core));
        let _permit = if coordination {
            None
        } else {
            Some(tokio::select! {
                biased;
                _ = cancel.cancelled() => anyhow::bail!("cancelled"),
                permit = self.tool_permits.acquire() => permit?,
            })
        };
        let runtime = if coordination {
            None
        } else {
            self.runtime.as_ref()
        };
        let (thread_id, turn_id, existing_scope) = {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().unwrap();
            anyhow::ensure!(
                !state.thread.turns.last().unwrap().items.iter().any(
                    |item| matches!(item, Item::DynamicToolCall {call_id,..} if call_id==&call.id)
                ),
                "duplicate tool call ID; refusing replay"
            );
            (
                state.thread.id.clone(),
                active.id.clone(),
                active.scope.clone(),
            )
        };
        let scope = match (runtime, if coordination { None } else { existing_scope }) {
            (_, Some(scope)) => scope,
            (Some(runtime), None) => {
                let client = &runtime.client;
                let scope = client
                    .create_scope(rt::CreateScope {
                        operation_id: client.operation_id(),
                        parent_scope_id: client.info().root_scope_id.clone(),
                        owner: rt::Owner {
                            task_id: format!("{thread_id}/{turn_id}"),
                            plugin_instance_id: None,
                        },
                        permissions: self.active_permissions(cell).await,
                        limits: rt::LimitRequest::default(),
                    })
                    .await?
                    .scope_id;
                cell.state.lock().await.active.as_mut().unwrap().scope = Some(scope.clone());
                scope
            }
            (None, None) => String::new(),
        };
        anyhow::ensure!(!cancel.is_cancelled(), "cancelled");
        let started = std::time::Instant::now();
        let item_id = id();
        let operation_id = runtime.map_or_else(id, |r| r.client.operation_id());
        let item = Item::DynamicToolCall {
            id: item_id.clone(),
            tool: call.name.clone(),
            // Preserve malformed input as a string in the audit record. Only
            // successfully parsed requests can reach Runtime execution below.
            arguments: serde_json::from_str(&call.arguments)
                .unwrap_or_else(|_| Value::String(call.arguments.clone())),
            status: ToolStatus::InProgress,
            success: None,
            content_items: None,
            call_id: call.id.clone(),
            execution: Box::new(ToolExecution {
                backend: entry.as_ref().ok().map(|tool| {
                    match tool.backend {
                        Backend::Builtin => "runtime",
                        Backend::Agent => "agent",
                        Backend::Coordination => "coordination",
                        Backend::Core => "core",
                        Backend::Command(_) => "command",
                        Backend::Client => "client",
                        Backend::Mcp(_) => "mcp",
                        Backend::Plugin(_) => "plugin",
                    }
                    .into()
                }),
                hooks: Vec::new(),
                effective_arguments: None,
                model_arguments: None,
                plugin: None,
                runtime_epoch: runtime
                    .map_or_else(String::new, |r| r.client.info().runtime_epoch.clone()),
                scope_id: scope.clone(),
                operation_id: operation_id.clone(),
                outcome: ToolOutcome::Running,
                inspection: None,
                duration_ms: None,
            }),
        };
        {
            let mut state = cell.state.lock().await;
            let mut candidate = state.thread.clone();
            candidate.turns.last_mut().unwrap().items.push(item.clone());
            self.persist(&candidate).await?; // The journal must reach durable storage BEFORE submission.
            state.thread = candidate;
            state
                .active
                .as_mut()
                .unwrap()
                .open_items
                .insert(item_id.clone());
            emit_item(cell, "item/started", &thread_id, &turn_id, &item);
        }
        let submitted = !cancel.is_cancelled();
        let mut post_hook_failed = false;
        let result = if let Err(error) = entry {
            Err(rt::Error::new(
                rt::ErrorCode::InvalidArgument,
                error.to_string(),
            ))
        } else if submitted {
            (extensions::Invocation {
                engine: self,
                cell,
                cancel,
                call: &call,
                scope: &scope,
                operation: &operation_id,
                item_id: &item_id,
                thread_id: &thread_id,
                turn_id: &turn_id,
                host: bindings.host,
                entry: entry.unwrap(),
            })
            .run(&mut post_hook_failed)
            .await
        } else {
            Err(rt::Error::new(
                rt::ErrorCode::ScopeClosed,
                "cancelled before submission",
            ))
        };
        let (outcome, success, mut result) = match result {
            Ok((success, value)) => (
                if success {
                    ToolOutcome::Succeeded
                } else {
                    ToolOutcome::Failed
                },
                success,
                value,
            ),
            Err(error) => {
                let outcome = if matches!(
                    error.code,
                    rt::ErrorCode::Unavailable
                        | rt::ErrorCode::CleanupFailed
                        | rt::ErrorCode::StaleHandle
                ) {
                    ToolOutcome::Unknown
                } else if error.code == rt::ErrorCode::ScopeClosed {
                    ToolOutcome::Cancelled
                } else {
                    ToolOutcome::Failed
                };
                (outcome, false, json!({"error":error}))
            }
        };
        let unknown = outcome == ToolOutcome::Unknown;
        let cursor = result["processId"]
            .as_str()
            .zip(result["nextCursor"].as_str())
            .map(|(process, cursor)| (process.to_owned(), cursor.to_owned()));
        if let Some(runtime) = runtime {
            cell.state
                .lock()
                .await
                .active
                .as_mut()
                .unwrap()
                .handles
                .expose(
                    &call.name,
                    &serde_json::from_str(&call.arguments).unwrap_or(Value::Null),
                    &mut result,
                    runtime,
                );
        }
        if let Some(object) = result.as_object_mut() {
            let state = cell.state.lock().await;
            let items = &state.thread.turns.last().unwrap().items;
            let used = items
                .iter()
                .filter(|i| matches!(i, Item::DynamicToolCall { .. }))
                .count();
            object.insert(
                "remainingToolCalls".into(),
                json!(self.extensions.agents.as_ref().map_or_else(
                    || self.limits.max_tool_calls.saturating_sub(used),
                    |a| {
                        a.max_tool_calls
                            .saturating_sub(self.agent_tool_calls.load(Ordering::Relaxed))
                    }
                )),
            );
            if call.name == "verify_command" {
                let args: Value = serde_json::from_str(&call.arguments).unwrap_or(Value::Null);
                let repeats = items.iter().filter(|i| matches!(i,Item::DynamicToolCall{tool,arguments,id,..} if tool == "verify_command" && id != &item_id && arguments["argv"] == args["argv"] && arguments["cwd"] == args["cwd"])).count();
                object.insert("previousSameCommandCalls".into(), json!(repeats));
                if repeats > 0 {
                    object.insert("verificationNote".into(), json!("Repeated command: compare current source and unresolved assertions with earlier receipts. Rerun when inputs changed; results are never automatically cached."));
                }
            }
        }
        let custom_content = result
            .get("contentItems")
            .map(|_| extensions::content_items(&result));
        let result = serde_json::to_string(&result)?;
        // Bound persisted and model-visible results including JSON escaping.
        let result = if result.len() > MAX_RESULT {
            json!({"truncated":true,"prefix":prefix(&result, MAX_RESULT / 2)}).to_string()
        } else {
            result
        };
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let item = candidate
            .turns
            .last_mut()
            .unwrap()
            .items
            .iter_mut()
            .find(|item| item.id() == item_id)
            .unwrap();
        if let Item::DynamicToolCall {
            status,
            success: saved_success,
            content_items,
            execution,
            ..
        } = item
        {
            *status = if success {
                ToolStatus::Completed
            } else {
                ToolStatus::Failed
            };
            *saved_success = Some(success);
            *content_items = Some(
                custom_content.unwrap_or_else(|| vec![json!({"type":"inputText","text":result})]),
            );
            execution.outcome = outcome;
            execution.duration_ms = Some(started.elapsed().as_millis() as u64);
        }
        let bytes = serde_json::to_vec(item)?.len();
        let item = item.clone();
        if let Err(error) = self.persist(&candidate).await {
            state.poisoned = true;
            return Err(error.into());
        }
        state.thread = candidate;
        if let Some((process, cursor)) = cursor {
            state
                .active
                .as_mut()
                .unwrap()
                .process_cursors
                .insert(process, cursor);
        }
        state.active.as_mut().unwrap().open_items.remove(&item_id);
        emit_item(cell, "item/completed", &thread_id, &turn_id, &item);
        anyhow::ensure!(
            !unknown,
            "tool outcome is UNKNOWN; inspect the workspace before continuing; automatic replay is disabled"
        );
        anyhow::ensure!(
            !post_hook_failed,
            "post-tool hook failed; tool result is retained; automatic replay is disabled"
        );
        Ok(bytes)
    }
}

pub(super) fn prefix(text: &str, bytes: usize) -> &str {
    let mut end = text.len().min(bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
async fn execute(
    client: &Client,
    request: Request,
    scope: &str,
    operation: &str,
    policy: &ToolPolicy,
) -> rt::Result<(bool, Value)> {
    match request {
        Request::File(command) => {
            let mut result = client
                .filesystem(rt::FileRequest {
                    operation_id: operation.into(),
                    scope_id: scope.into(),
                    command,
                })
                .await?;
            if let Some(encoded) = result["dataBase64"].as_str()
                && let Ok(bytes) = STANDARD.decode(encoded)
                && let Ok(text) = String::from_utf8(bytes)
                && serde_json::to_string(&text).unwrap().len() < MAX_RESULT - 512
            {
                result["text"] = json!(text);
                result.as_object_mut().unwrap().remove("dataBase64");
            }
            Ok((true, result))
        }
        Request::Command(command) => {
            let effective_timeout_ms = command.timeout_ms;
            let started = client
                .start(rt::StartProcess {
                    operation_id: operation.into(),
                    scope_id: scope.into(),
                    argv: command.argv,
                    cwd: command.cwd,
                    env: BTreeMap::new(),
                    tty: command.tty,
                    pipe_stdin: !command.tty,
                    limits: rt::LimitRequest {
                        wall_time_ms: Some(command.timeout_ms),
                        output_bytes: None,
                        max_processes: None,
                    },
                })
                .await?;
            let (success, mut result) = process_output(
                client,
                scope,
                ReadProcess {
                    process_id: started.process_id,
                    after: None,
                    wait_ms: command.yield_ms.unwrap_or(if command.tty {
                        policy.pty_wait_ms
                    } else {
                        policy.command_wait_ms
                    }),
                },
                policy.output_quiet_ms,
            )
            .await?;
            result["effectiveTimeoutMs"] = json!(effective_timeout_ms);
            Ok((success, result))
        }
        Request::ReadProcess(read) => {
            process_output(client, scope, read, policy.output_quiet_ms).await
        }
        Request::WriteProcess(write) => {
            owned_process(client, scope, &write.process_id).await?;
            let result = client
                .write(rt::ProcessInput {
                    operation_id: operation.into(),
                    process_id: write.process_id,
                    data_base64: STANDARD.encode(write.text),
                })
                .await?;
            Ok((true, result))
        }
        Request::TerminateProcess(process) => {
            owned_process(client, scope, &process.process_id).await?;
            client.terminate(&process.process_id).await?;
            let done = client.wait(&process.process_id).await?;
            Ok((true, json!(done)))
        }
    }
}

pub(crate) async fn verify_command(
    client: &Client,
    argv: Vec<String>,
) -> rt::Result<(bool, Value)> {
    // Model-facing waits may return on an output burst while a command is still
    // running. Verification must consume the stream and observe the final exit.
    let process = client
        .start(rt::StartProcess {
            operation_id: client.operation_id(),
            scope_id: client.info().root_scope_id.clone(),
            argv,
            cwd: "workspace://repo".into(),
            env: BTreeMap::new(),
            tty: false,
            pipe_stdin: false,
            limits: rt::LimitRequest::default(),
        })
        .await?;
    let mut after = None;
    let mut output = Vec::new();
    let mut truncated = false;
    loop {
        let page = client
            .output(rt::ReadOutput {
                process_id: process.process_id.clone(),
                after,
                max_bytes: 8192,
                wait_ms: 1000,
            })
            .await?;
        truncated |= page.gap || page.truncated;
        for chunk in page.chunks {
            let bytes = STANDARD.decode(chunk.data_base64).map_err(|_| {
                rt::Error::new(rt::ErrorCode::Unavailable, "invalid Runtime output")
            })?;
            output.extend(bytes);
            if output.len() > MAX_RESULT / 2 {
                output.drain(..output.len() - MAX_RESULT / 2);
                truncated = true;
            }
        }
        after = Some(page.next_cursor);
        if page.closed {
            break;
        }
    }
    let done = client.wait(&process.process_id).await?;
    let success = done.state == rt::ProcessState::Exited
        && done.exit_code == Some(0)
        && done.stop_reason.is_none();
    let mut result = json!(done);
    result["output"] = json!(String::from_utf8_lossy(&output));
    result["truncated"] = json!(truncated);
    Ok((success, result))
}

pub(crate) fn workspace_uri(path: &str, workspace: &std::path::Path) -> anyhow::Result<String> {
    use std::path::{Component, Path};
    if path == "workspace://scratch" || path.starts_with("workspace://scratch/") {
        return workspace_uri(
            &path.replacen("workspace://scratch", "workspace://repo", 1),
            workspace,
        )
        .map(|p| p.replacen("workspace://repo", "workspace://scratch", 1));
    }
    anyhow::ensure!(
        !path.is_empty() && !path.contains(['\\', '\0']),
        "invalid workspace path"
    );
    let path = if path == "workspace://repo" {
        "."
    } else if let Some(relative) = path.strip_prefix("workspace://repo/") {
        anyhow::ensure!(!relative.starts_with('/'), "invalid workspace URI");
        relative
    } else {
        anyhow::ensure!(!path.contains("://"), "unsupported workspace URI");
        path
    };
    let path = Path::new(path);
    let path = if path.is_absolute() {
        path.strip_prefix(workspace)
            .context("absolute path is outside the workspace")?
    } else {
        path
    };
    let mut parts = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(part) => parts.push(part.to_str().context("path must be UTF-8")?),
            Component::CurDir => {}
            _ => anyhow::bail!("workspace paths cannot traverse parent directories"),
        }
    }
    Ok(if parts.is_empty() {
        "workspace://repo".into()
    } else {
        format!("workspace://repo/{}", parts.join("/"))
    })
}

fn resource_uri(path: &str, runtime: &RuntimeConfig) -> anyhow::Result<String> {
    if let Some(root) = &runtime.command_scratch
        && Path::new(path).is_absolute()
        && let Ok(relative) = Path::new(path).strip_prefix(root)
    {
        return workspace_uri(
            &format!("workspace://scratch/{}", relative.display()),
            &runtime.workspace,
        );
    }
    workspace_uri(path, &runtime.workspace)
}

async fn owned_process(client: &Client, scope: &str, process: &str) -> rt::Result<rt::ProcessInfo> {
    let info = client.process(process).await?;
    if info.scope_id != scope {
        return Err(rt::Error::new(
            rt::ErrorCode::PermissionDenied,
            "process belongs to another Turn",
        ));
    }
    Ok(info)
}

async fn process_output(
    client: &Client,
    scope: &str,
    read: ReadProcess,
    output_quiet_ms: u64,
) -> rt::Result<(bool, Value)> {
    owned_process(client, scope, &read.process_id).await?;
    let started = tokio::time::Instant::now();
    let budget = Duration::from_millis(read.wait_ms);
    let mut last_output: Option<tokio::time::Instant> = None;
    let mut after = read.after;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut gap = false;
    let mut truncated = false;
    let mut closed = false;
    // Bound bytes before JSON expansion; callers can read the next cursor.
    let mut remaining = 2048usize;
    let return_reason = loop {
        let mut wait = budget.saturating_sub(started.elapsed());
        if output_quiet_ms > 0
            && let Some(last) = last_output
        {
            wait = wait.min(Duration::from_millis(output_quiet_ms).saturating_sub(last.elapsed()));
        }
        let wait_ms = wait.as_millis().min(1000) as u64;
        let page = client
            .output(rt::ReadOutput {
                process_id: read.process_id.clone(),
                after,
                max_bytes: remaining,
                wait_ms: wait_ms.min(1000),
            })
            .await?;
        gap |= page.gap;
        truncated |= page.truncated;
        if !page.chunks.is_empty() {
            // Output arrival does not hand control back to the model by default.
            // An explicit nonzero policy can restore legacy burst coalescing.
            last_output = Some(tokio::time::Instant::now());
        }
        for chunk in page.chunks {
            let bytes = STANDARD.decode(chunk.data_base64).map_err(|_| {
                rt::Error::new(rt::ErrorCode::Unavailable, "invalid Runtime output")
            })?;
            remaining = remaining.saturating_sub(bytes.len());
            match chunk.stream {
                rt::OutputStream::Stdout | rt::OutputStream::Pty => stdout.extend(bytes),
                rt::OutputStream::Stderr => stderr.extend(bytes),
            }
        }
        after = Some(page.next_cursor);
        closed |= page.closed;
        if gap || truncated {
            break "outputLoss";
        }
        if closed {
            break "completed";
        }
        if remaining == 0 {
            break "outputLimit";
        }
        if started.elapsed() >= budget {
            break "waitBudget";
        }
        if output_quiet_ms > 0
            && last_output
                .is_some_and(|last| last.elapsed() >= Duration::from_millis(output_quiet_ms))
        {
            break "outputQuiet";
        }
    };
    let info = owned_process(client, scope, &read.process_id).await?;
    if info.state == rt::ProcessState::Unknown {
        return Err(rt::Error::new(
            rt::ErrorCode::Unavailable,
            "process outcome is UNKNOWN",
        ));
    }
    let success = info.state != rt::ProcessState::Unknown
        && (info.state != rt::ProcessState::Exited
            || (info.exit_code == Some(0) && info.stop_reason.is_none()));
    let command_status = if info.state != rt::ProcessState::Exited {
        "running"
    } else if info.stop_reason.is_some() {
        "terminated"
    } else if info.exit_code == Some(0) {
        "succeeded"
    } else {
        "failed"
    };
    let mut result = json!({"processId":read.process_id, "state":info.state, "returnReason":return_reason, "exitCode":info.exit_code, "stopReason":info.stop_reason, "stdout":String::from_utf8_lossy(&stdout), "stderr":String::from_utf8_lossy(&stderr), "nextCursor":after, "outputClosed":closed, "gap":gap, "truncated":truncated,
        "commandStatus":command_status,"outputReadComplete":closed,
        "outputIntegrity":if gap || truncated { "incomplete" } else { "retained" },
        "nextAction":if !closed { "Read this process again to collect remaining/new output; omit after to continue." } else { "Retained output has been read to its end. Evaluate the actual checks; exit zero alone does not prove correctness." }});
    if std::str::from_utf8(&stdout).is_err() {
        result["stdoutBase64"] = json!(STANDARD.encode(stdout));
    }
    if std::str::from_utf8(&stderr).is_err() {
        result["stderrBase64"] = json!(STANDARD.encode(stderr));
    }
    Ok((success, result))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod request_tests {
    use super::*;

    fn request(call: &ToolCall) -> anyhow::Result<Request> {
        super::request(call, Path::new("/app"), "epoch", &BTreeMap::new())
    }

    #[test]
    fn creation_and_relative_paths_preserve_runtime_authority() {
        let call = |args: Value| ToolCall {
            id: "create".into(),
            name: "fs_create".into(),
            arguments: args.to_string(),
        };
        for path in ["src/new.py", "./src//new.py", "workspace://repo/src/new.py"] {
            let parsed = request(&call(json!({"path":path,"text":"source"}))).unwrap();
            assert!(
                matches!(parsed, Request::File(rt::FileCommand::Write { path, expected:rt::ExpectedFile::Absent, .. }) if path=="workspace://repo/src/new.py")
            );
        }
        for path in [
            "",
            "../secret",
            "src/../secret",
            "/etc/passwd",
            "file:///tmp/file",
            "..\\secret",
        ] {
            assert!(
                request(&call(json!({"path":path,"text":"source"}))).is_err(),
                "{path}"
            );
        }
        assert!(
            request(&call(
                json!({"path":"new.py","text":"source","expectedSha256":null})
            ))
            .is_err()
        );
        let command = ToolCall {
            id: "run".into(),
            name: "run_command".into(),
            arguments: json!({"argv":["pwd"],"cwd":".","timeoutMs":1000}).to_string(),
        };
        assert!(
            matches!(request(&command).unwrap(), Request::Command(Command { cwd, .. }) if cwd=="workspace://repo")
        );
    }

    #[test]
    fn conditional_write_rejects_ambiguous_hashes_before_runtime_execution() {
        let call = |expected: Value| ToolCall {
            id: "write".into(),
            name: "fs_write".into(),
            arguments:
                json!({"path":"workspace://repo/new.py","text":"source","expectedSha256":expected})
                    .to_string(),
        };
        assert!(matches!(
            request(&call(Value::Null)).unwrap(),
            Request::File(rt::FileCommand::Write {
                expected: rt::ExpectedFile::Absent,
                ..
            })
        ));
        assert!(request(&call(json!("a".repeat(64)))).is_ok());
        for bad in [
            "null".to_owned(),
            String::new(),
            "a".repeat(63),
            "a".repeat(65),
            "g".repeat(64),
        ] {
            let error = request(&call(json!(bad))).err().unwrap().to_string();
            assert!(error.contains("explicit JSON null"), "{error}");
        }
        let missing = ToolCall {
            id: "write".into(),
            name: "fs_write".into(),
            arguments: json!({"path":"workspace://repo/new.py","text":"source"}).to_string(),
        };
        assert!(
            request(&missing)
                .err()
                .unwrap()
                .to_string()
                .contains("requires an explicit")
        );
        let patch=ToolCall { id:"patch".into(),name:"fs_apply_patch".into(),arguments:json!({"path":"workspace://repo/a.py","oldText":"x","newText":"y","expectedSha256":"null"}).to_string() };
        assert!(request(&patch).is_err());
    }
}
