//! Trusted Node plugin hosts. Only Core can bind a call to Runtime capabilities.
use super::*;
use anyhow::ensure;
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    ffi::OsString,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin},
    sync::Mutex,
};
use tokio_util::codec::{FramedRead, LinesCodec};

const FRAME_LIMIT: usize = 128 * 1024;
pub const MAX_OPERATIONS: usize = 32;
pub(super) const MAX_JOURNAL: usize = 8 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginConfig {
    pub trusted: bool,
    #[serde(default)]
    pub allow_process: bool,
    pub argv: Vec<String>,
    pub read_roots: Vec<String>,
    #[serde(default)]
    pub write_roots: Vec<String>,
    pub timeout_ms: u64,
}

pub fn valid_path(path: &str) -> bool {
    path == "workspace://repo"
        || path.strip_prefix("workspace://repo/").is_some_and(|tail| {
            !tail.is_empty()
                && tail.len() <= 1024
                && !tail.contains(['\\', '\0'])
                && tail.split('/').all(|p| !matches!(p, "" | "." | ".."))
        })
}
fn within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
impl PluginConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.trusted,
            "plugin Host currently requires explicit trusted: true; OS isolation is not implemented"
        );
        super::registry::validate_command(&self.argv, self.timeout_ms)?;
        ensure!(self.argv.len() <= 32, "plugin argv exceeds 32 entries");
        ensure!(
            self.argv.iter().map(String::len).sum::<usize>() <= 16 * 1024,
            "plugin argv exceeds 16 KiB"
        );
        ensure!(
            self.read_roots.len() <= 16 && self.write_roots.len() <= 16,
            "plugin roots exceed 16 entries"
        );
        ensure!(
            self.read_roots
                .iter()
                .chain(&self.write_roots)
                .all(|p| valid_path(p)),
            "plugin roots must be canonical workspace://repo paths"
        );
        ensure!(
            self.write_roots
                .iter()
                .all(|p| self.read_roots.iter().any(|r| within(p, r))),
            "plugin write roots must be within read roots"
        );
        Ok(())
    }
    pub fn allows(&self, command: &rt::FileCommand) -> bool {
        let roots = if command.writes() {
            &self.write_roots
        } else {
            &self.read_roots
        };
        valid_path(command.path()) && roots.iter().any(|r| within(command.path(), r))
    }
}

#[async_trait::async_trait]
pub(crate) trait FileBroker: Sync {
    async fn execute(&self, command: rt::FileCommand) -> rt::Result<Value>;
    async fn process(&self, command: ProcessCommand) -> rt::Result<Value>;
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeHostReady {
    protocol_version: u32,
    tools: Vec<areal_protocol::ToolDefinition>,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeHostMessage {
    Process {
        call_id: String,
        request_id: u64,
        command: ProcessCommand,
    },
    File {
        call_id: String,
        request_id: u64,
        command: rt::FileCommand,
    },
    Result {
        call_id: String,
        response: areal_protocol::DynamicToolResponse,
    },
}

struct Session {
    child: Child,
    input: ChildStdin,
    output: FramedRead<tokio::process::ChildStdout, LinesCodec>,
}
impl Session {
    async fn read<T: serde::de::DeserializeOwned>(&mut self) -> anyhow::Result<T> {
        let line = self
            .output
            .next()
            .await
            .context("plugin Host closed its output")??;
        Ok(serde_json::from_str(&line)?)
    }
    async fn write(&mut self, value: Value) -> anyhow::Result<()> {
        let mut bytes = serde_json::to_vec(&value)?;
        ensure!(bytes.len() < FRAME_LIMIT, "plugin frame exceeds 128 KiB");
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        self.input.flush().await?;
        Ok(())
    }
    async fn stop(&mut self) -> anyhow::Result<()> {
        // This is process ownership, not an OS sandbox. The Host remains trusted.
        self.child.start_kill()?;
        tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await??;
        Ok(())
    }
}

pub struct PluginHost {
    pub id: String,
    pub generation: String,
    pub config: PluginConfig,
    protocol_version: u32,
    definitions: Vec<areal_protocol::ToolDefinition>,
    session: Mutex<Session>,
    stop: CancellationToken,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct PluginTool {
    pub definition: areal_protocol::ToolDefinition,
    pub host: Arc<PluginHost>,
}

impl PluginHost {
    pub async fn launch(
        id: &str,
        config: &PluginConfig,
        base: &Path,
        env: &BTreeMap<OsString, OsString>,
    ) -> anyhow::Result<Arc<Self>> {
        config.validate()?;
        let mut command = tokio::process::Command::new(&config.argv[0]);
        command
            .args(&config.argv[1..])
            .current_dir(base)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for key in ["PATH", "LANG", "LC_ALL", "SYSTEMROOT"]
            .into_iter()
            .chain(areal_config::PROXY_ENV_VARS)
        {
            if let Some(value) = env.get(std::ffi::OsStr::new(key)) {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().context("cannot launch plugin Host")?;
        let mut session = Session {
            input: child.stdin.take().unwrap(),
            output: FramedRead::new(
                child.stdout.take().unwrap(),
                LinesCodec::new_with_max_length(FRAME_LIMIT),
            ),
            child,
        };
        let ready =
            tokio::time::timeout(Duration::from_secs(10), session.read::<NativeHostReady>()).await;
        let ready = match ready {
            Ok(Ok(ready))
                if matches!(ready.protocol_version, 1 | 2)
                    && !ready.tools.is_empty()
                    && ready.tools.len() <= 32 =>
            {
                ready
            }
            other => {
                let _ = session.stop().await;
                anyhow::bail!(
                    "plugin Host handshake failed: {}",
                    match other {
                        Ok(Err(e)) => e.to_string(),
                        Err(e) => e.to_string(),
                        _ => "unsupported version or tool count".into(),
                    }
                );
            }
        };
        Ok(Arc::new(Self {
            id: id.into(),
            generation: format!("{id}:{}", uuid::Uuid::new_v4()),
            config: config.clone(),
            protocol_version: ready.protocol_version,
            definitions: ready.tools,
            session: Mutex::new(session),
            stop: CancellationToken::new(),
            closed: AtomicBool::new(false),
        }))
    }
    pub fn tools(self: &Arc<Self>) -> Vec<PluginTool> {
        self.definitions
            .iter()
            .map(|definition| PluginTool {
                definition: definition.clone(),
                host: self.clone(),
            })
            .collect()
    }
    pub async fn shutdown(&self) -> anyhow::Result<()> {
        self.closed.store(true, Ordering::Release);
        self.stop.cancel();
        self.session.lock().await.stop().await
    }
    pub(crate) async fn call(
        &self,
        params: Value,
        cancel: &CancellationToken,
        broker: &dyn FileBroker,
    ) -> rt::Result<areal_protocol::DynamicToolResponse> {
        let unavailable = |message: String| rt::Error::new(rt::ErrorCode::Unavailable, message);
        let mut session = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(unavailable("plugin call cancelled".into())),
            _ = self.stop.cancelled() => return Err(unavailable("plugin Host closed".into())),
            guard = self.session.lock() => guard,
        };
        if self.closed.load(Ordering::Acquire) {
            return Err(unavailable("plugin generation is closed".into()));
        }
        let call_id = uuid::Uuid::new_v4().to_string();
        let exchange = async {
            session
                .write(json!({"type":"call", "callId":call_id, "params":params}))
                .await?;
            let mut requests = HashSet::new();
            loop {
                match session.read::<NativeHostMessage>().await? {
                    NativeHostMessage::Process {
                        call_id: reply_id,
                        request_id,
                        command,
                    } => {
                        ensure!(
                            self.protocol_version == 2,
                            "process broker requires native Host protocol v2"
                        );
                        ensure!(
                            reply_id == call_id,
                            "process request belongs to another call"
                        );
                        ensure!(
                            requests.len() < MAX_OPERATIONS && requests.insert(request_id),
                            "duplicate or excessive broker requests"
                        );
                        let result = broker.process(command).await;
                        session.write(match result {Ok(value)=>json!({"type":"processResult","callId":call_id,"requestId":request_id,"result":value}),Err(error)=>json!({"type":"processResult","callId":call_id,"requestId":request_id,"error":error})}).await?;
                    }
                    NativeHostMessage::Result {
                        call_id: reply_id,
                        response,
                    } => {
                        ensure!(reply_id == call_id, "stale plugin call result");
                        return Ok::<_, anyhow::Error>(response);
                    }
                    NativeHostMessage::File {
                        call_id: reply_id,
                        request_id,
                        command,
                    } => {
                        ensure!(reply_id == call_id, "file request belongs to another call");
                        ensure!(
                            requests.len() < MAX_OPERATIONS && requests.insert(request_id),
                            "duplicate or excessive plugin file requests"
                        );
                        let result = broker.execute(command).await;
                        let response = match result {
                            Ok(value) => {
                                json!({"type":"fileResult","callId":call_id,"requestId":request_id,"result":value})
                            }
                            Err(error) => {
                                json!({"type":"fileResult","callId":call_id,"requestId":request_id,"error":error})
                            }
                        };
                        session.write(response).await?;
                    }
                }
            }
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(anyhow::anyhow!("plugin call cancelled; outcome may be UNKNOWN")),
            _ = self.stop.cancelled() => Err(anyhow::anyhow!("plugin generation unloaded")),
            result = tokio::time::timeout(Duration::from_millis(self.config.timeout_ms), exchange) => result.unwrap_or_else(|_| Err(anyhow::anyhow!("plugin call timed out; outcome may be UNKNOWN"))),
        };
        if result.is_err() {
            self.closed.store(true, Ordering::Release);
            self.stop.cancel();
            session
                .stop()
                .await
                .map_err(|e| unavailable(format!("plugin cleanup failed: {e}")))?;
        }
        result.map_err(|e| unavailable(e.to_string()))
    }
}

#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProcessCommand {
    Start {
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        tty: bool,
        timeout_ms: u64,
    },
    Get {
        process_id: String,
    },
    Read {
        process_id: String,
        after: Option<String>,
        max_bytes: usize,
        wait_ms: u64,
    },
    Write {
        process_id: String,
        data_base64: String,
    },
    Resize {
        process_id: String,
        cols: u16,
        rows: u16,
    },
    CloseStdin {
        process_id: String,
    },
    Terminate {
        process_id: String,
    },
}
impl ProcessCommand {
    pub fn process_id(&self) -> Option<&str> {
        match self {
            Self::Start { .. } => None,
            Self::Get { process_id }
            | Self::Read { process_id, .. }
            | Self::Write { process_id, .. }
            | Self::Resize { process_id, .. }
            | Self::CloseStdin { process_id }
            | Self::Terminate { process_id } => Some(process_id),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> PluginConfig {
        PluginConfig {
            trusted: true,
            allow_process: false,
            argv: vec!["node".into(), "plugin.mjs".into()],
            read_roots: vec!["workspace://repo/src".into()],
            write_roots: vec!["workspace://repo/src/generated".into()],
            timeout_ms: 1000,
        }
    }

    #[tokio::test]
    async fn plugin_host_inherits_proxies_without_other_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let mut policy = config();
        policy.argv = vec![
            "/usr/bin/python3".into(), "-I".into(), "-S".into(), "-c".into(),
            "import json,os,sys; open('environment.json','w').write(json.dumps(dict(os.environ))); print(json.dumps({'protocolVersion':1,'tools':[{'name':'fixture','description':'fixture','inputSchema':{'type':'object'}}]}),flush=True); sys.stdin.read()".into(),
        ];
        let mut env = BTreeMap::from([(
            OsString::from("MODEL_API_KEY"),
            OsString::from("must-not-inherit"),
        )]);
        for key in areal_config::PROXY_ENV_VARS {
            env.insert(key.into(), format!("fixture-{key}").into());
        }
        let host = PluginHost::launch("fixture", &policy, temp.path(), &env)
            .await
            .unwrap();
        let observed: Value =
            serde_json::from_slice(&std::fs::read(temp.path().join("environment.json")).unwrap())
                .unwrap();
        host.shutdown().await.unwrap();
        assert!(observed.get("MODEL_API_KEY").is_none());
        for key in areal_config::PROXY_ENV_VARS {
            assert_eq!(observed[key], format!("fixture-{key}"));
        }
    }

    #[test]
    fn plugin_capabilities_do_not_expand_through_prefixes_or_traversal() {
        let policy = config();
        policy.validate().unwrap();
        for path in ["workspace://repo/src", "workspace://repo/src/a.ts"] {
            assert!(policy.allows(&rt::FileCommand::Stat { path: path.into() }));
        }
        for path in [
            "workspace://repo/src2/a",
            "workspace://repo/src/../secret",
            "workspace://repo/src//a",
            "workspace://repo/src/./a",
            "workspace://other/src",
            "/etc/passwd",
        ] {
            assert!(!policy.allows(&rt::FileCommand::Stat { path: path.into() }));
        }
        let write = |path| {
            serde_json::from_value::<rt::FileCommand>(
                json!({"kind":"write","path":path,"dataBase64":"","expected":{"kind":"absent"}}),
            )
            .unwrap()
        };
        assert!(policy.allows(&write("workspace://repo/src/generated/a")));
        assert!(!policy.allows(&write("workspace://repo/src/a")));
        assert!(!policy.allows(&write("workspace://repo/src/generated2/a")));
        let mut invalid = config();
        invalid.trusted = false;
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.write_roots = vec!["workspace://repo/secret".into()];
        assert!(invalid.validate().is_err());
        let mut invalid = config();
        invalid.timeout_ms = 0;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn host_cannot_supply_runtime_identity_or_unknown_fields() {
        let message = json!({"type":"file", "callId":"call", "requestId":1, "command":{"kind":"stat","path":"workspace://repo/src/a"}});
        assert!(serde_json::from_value::<NativeHostMessage>(message.clone()).is_ok());
        for field in ["scopeId", "operationId", "threadId"] {
            let mut forged = message.clone();
            forged[field] = json!("forged");
            assert!(serde_json::from_value::<NativeHostMessage>(forged).is_err());
        }
    }
}
