//! Per-call capability binding and durable nested operation facts.
use super::*;
use areal_protocol::{PluginExecution, PluginOperation};
use extensions::Invocation;
use plugins::{FileBroker, PluginTool};
use sha2::{Digest, Sha256};

struct Broker<'a, 'b> {
    invocation: &'a Invocation<'b>,
    tool: &'a PluginTool,
    scope: &'a str,
    processes: tokio::sync::Mutex<HashSet<String>>,
}

fn invalid(message: impl ToString) -> rt::Error {
    rt::Error::new(rt::ErrorCode::InvalidArgument, message.to_string())
}
fn unknown(message: impl ToString) -> rt::Error {
    rt::Error::new(rt::ErrorCode::Unavailable, message.to_string())
}

#[async_trait::async_trait]
impl FileBroker for Broker<'_, '_> {
    async fn execute(&self, command: rt::FileCommand) -> rt::Result<Value> {
        let invocation = self.invocation;
        if invocation.cancel.is_cancelled() {
            return Err(unknown("plugin call cancelled"));
        }
        if !self.tool.host.config.allows(&command) {
            return Err(rt::Error::new(
                rt::ErrorCode::PermissionDenied,
                "plugin path is outside its configured capability",
            ));
        }
        invocation
            .engine
            .approval(
                invocation.cell,
                &invocation.call.id,
                if command.writes() {
                    "broker:fs.write"
                } else {
                    "broker:fs.read"
                },
                &json!({"tool":invocation.call.name,"generation":self.tool.host.generation,"scopeId":self.scope,"command":command}),
                invocation.cancel,
            )
            .await?;
        let kind = match &command {
            rt::FileCommand::Read {
                offset: 0,
                max_bytes,
                ..
            } if *max_bytes <= 32 * 1024 => "read",
            rt::FileCommand::Stat { .. } => "stat",
            rt::FileCommand::Write { data_base64, .. } => {
                if STANDARD.decode(data_base64).map_err(invalid)?.len() > 32 * 1024 {
                    return Err(invalid("plugin files are limited to 32 KiB"));
                }
                "write"
            }
            _ => {
                return Err(rt::Error::new(
                    rt::ErrorCode::Unsupported,
                    "plugin fs supports stat, full read and conditional write for files up to 32 KiB",
                ));
            }
        };
        let client = &invocation.engine.runtime.as_ref().unwrap().client;
        let operation = client.operation_id();
        let record = PluginOperation {
            operation_id: operation.clone(),
            kind: kind.into(),
            path: command.path().into(),
            request_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&command).map_err(invalid)?)
            ),
            outcome: ToolOutcome::Running,
            result: None,
        };
        let mut admitted = false;
        invocation
            .edit(|execution, _| {
                let plugin = execution.plugin.as_mut().unwrap();
                if serde_json::to_vec(plugin).unwrap().len()
                    + serde_json::to_vec(&record).unwrap().len()
                    + 512
                    <= plugins::MAX_JOURNAL
                {
                    plugin.operations.push(record);
                    admitted = true;
                }
            })
            .await?;
        if !admitted {
            return Err(rt::Error::new(
                rt::ErrorCode::ResourceExhausted,
                "plugin operation journal exceeds 8 KiB",
            ));
        }
        let result = client
            .filesystem(rt::FileRequest {
                operation_id: operation.clone(),
                scope_id: self.scope.into(),
                command,
            })
            .await;
        let (outcome, summary) = match &result {
            Ok(value) => (
                ToolOutcome::Succeeded,
                json!({"sha256":value["sha256"], "size":value["size"], "kind":value["kind"]}),
            ),
            Err(error) => (
                if matches!(
                    error.code,
                    rt::ErrorCode::Unavailable
                        | rt::ErrorCode::StaleHandle
                        | rt::ErrorCode::CleanupFailed
                ) {
                    ToolOutcome::Unknown
                } else {
                    ToolOutcome::Failed
                },
                json!({"code":error.code}),
            ),
        };
        invocation
            .edit(|execution, _| {
                let record = execution
                    .plugin
                    .as_mut()
                    .unwrap()
                    .operations
                    .iter_mut()
                    .find(|o| o.operation_id == operation)
                    .unwrap();
                record.outcome = outcome;
                record.result = Some(summary);
            })
            .await?;
        result
    }
    async fn process(&self, command: plugins::ProcessCommand) -> rt::Result<Value> {
        use plugins::ProcessCommand as P;
        let invocation = self.invocation;
        if invocation.cancel.is_cancelled() {
            return Err(unknown("native Host call cancelled"));
        }
        if !self.tool.host.config.allow_process {
            return Err(rt::Error::new(
                rt::ErrorCode::PermissionDenied,
                "native Host process capability not granted",
            ));
        }
        if let Some(id) = command.process_id()
            && !self.processes.lock().await.contains(id)
        {
            return Err(rt::Error::new(
                rt::ErrorCode::PermissionDenied,
                "process belongs to another Host call or generation",
            ));
        }
        let args = serde_json::to_value(&command).map_err(invalid)?;
        let kind = format!("process.{}", args["op"].as_str().unwrap());
        invocation
            .engine
            .approval(
                invocation.cell,
                &invocation.call.id,
                &format!("broker:{kind}"),
                &json!({"tool":invocation.call.name,"generation":self.tool.host.generation,"scopeId":self.scope,"command":args}),
                invocation.cancel,
            )
            .await?;
        let client = &invocation.engine.runtime.as_ref().unwrap().client;
        let operation = client.operation_id();
        let record = PluginOperation {
            operation_id: operation.clone(),
            kind,
            path: command.process_id().unwrap_or(self.scope).into(),
            request_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&args).map_err(invalid)?)
            ),
            outcome: ToolOutcome::Running,
            result: None,
        };
        let mut admitted = false;
        invocation
            .edit(|execution, _| {
                let p = execution.plugin.as_mut().unwrap();
                if serde_json::to_vec(p).unwrap().len()
                    + serde_json::to_vec(&record).unwrap().len()
                    + 512
                    <= plugins::MAX_JOURNAL
                {
                    p.operations.push(record);
                    admitted = true;
                }
            })
            .await?;
        if !admitted {
            return Err(rt::Error::new(
                rt::ErrorCode::ResourceExhausted,
                "native Host operation journal budget exhausted",
            ));
        }
        let result = match command {
            P::Start {
                argv,
                cwd,
                tty,
                timeout_ms,
            } => {
                if timeout_ms == 0 || timeout_ms > self.tool.host.config.timeout_ms {
                    Err(invalid("process timeout exceeds Host call budget"))
                } else {
                    client
                        .start(rt::StartProcess {
                            operation_id: operation.clone(),
                            scope_id: self.scope.into(),
                            argv,
                            cwd,
                            env: BTreeMap::new(),
                            tty,
                            pipe_stdin: !tty,
                            limits: rt::LimitRequest {
                                wall_time_ms: Some(timeout_ms),
                                ..Default::default()
                            },
                        })
                        .await
                        .map(|p| json!(p))
                }
            }
            P::Get { process_id } => client.process(&process_id).await.map(|v| json!(v)),
            P::Read {
                process_id,
                after,
                max_bytes,
                wait_ms,
            } => client
                .output(rt::ReadOutput {
                    process_id,
                    after,
                    max_bytes,
                    wait_ms,
                })
                .await
                .map(|v| json!(v)),
            P::Write {
                process_id,
                data_base64,
            } => client
                .write(rt::ProcessInput {
                    operation_id: operation.clone(),
                    process_id,
                    data_base64,
                })
                .await
                .map(|v| json!(v)),
            P::Resize {
                process_id,
                cols,
                rows,
            } => client
                .resize(rt::ResizeProcess {
                    operation_id: operation.clone(),
                    process_id,
                    cols,
                    rows,
                })
                .await
                .map(|v| json!(v)),
            P::CloseStdin { process_id } => client
                .close_stdin(rt::CloseStdin {
                    operation_id: operation.clone(),
                    process_id,
                })
                .await
                .map(|v| json!(v)),
            P::Terminate { process_id } => client.terminate(&process_id).await.map(|v| json!(v)),
        };
        if let Ok(value) = &result
            && let Some(id) = value["processId"].as_str()
        {
            self.processes.lock().await.insert(id.into());
        }
        invocation.edit(|execution,_|{let record=execution.plugin.as_mut().unwrap().operations.iter_mut().find(|r|r.operation_id==operation).unwrap();record.outcome=match &result{Ok(_)=>ToolOutcome::Succeeded,Err(e)if matches!(e.code,rt::ErrorCode::Unavailable|rt::ErrorCode::StaleHandle|rt::ErrorCode::CleanupFailed)=>ToolOutcome::Unknown,Err(_)=>ToolOutcome::Failed};record.result=Some(match &result{Ok(v)=>json!({"processId":v["processId"],"state":v["state"],"nextCursor":v["nextCursor"]}),Err(e)=>json!({"code":e.code})});}).await?;
        result
    }
}

impl Invocation<'_> {
    pub(super) async fn plugin(
        &self,
        tool: &PluginTool,
        args: &Value,
    ) -> rt::Result<areal_protocol::DynamicToolResponse> {
        let client = &self
            .engine
            .runtime
            .as_ref()
            .expect("plugins require Runtime")
            .client;
        let scope = client
            .create_scope(rt::CreateScope {
                operation_id: client.operation_id(),
                parent_scope_id: self.scope.into(),
                owner: rt::Owner {
                    task_id: format!("{}/{}", self.thread_id, self.turn_id),
                    plugin_instance_id: Some(tool.host.generation.clone()),
                },
                permissions: rt::PermissionRequest {
                    read_roots: Some(tool.host.config.read_roots.clone()),
                    write_roots: Some(tool.host.config.write_roots.clone()),
                    network: rt::NetworkRequest::Deny,
                },
                limits: rt::LimitRequest::default(),
            })
            .await?
            .scope_id;
        let result = async {
            self.edit(|execution, _| execution.plugin = Some(PluginExecution {
                plugin_id: tool.host.id.clone(), generation: tool.host.generation.clone(), scope_id: scope.clone(), operations: Vec::new(),
            })).await?;
            tool.host.call(
                json!({"threadId":self.thread_id, "turnId":self.turn_id, "tool":self.call.name, "arguments":args}),
                self.cancel, &Broker { invocation: self, tool, scope: &scope, processes:Default::default() },
            ).await
        }.await;
        // Never release the call while a nested Runtime resource remains owned.
        client.close_scope(&scope).await.map_err(unknown)?;
        let mut uncertain = false;
        self.edit(|execution, _| {
            if let Some(plugin) = &mut execution.plugin {
                for operation in &mut plugin.operations {
                    if operation.outcome == ToolOutcome::Running {
                        operation.outcome = ToolOutcome::Unknown;
                    }
                    uncertain |= operation.outcome == ToolOutcome::Unknown;
                }
            }
        })
        .await?;
        if uncertain {
            return Err(unknown(
                "nested plugin operation outcome is UNKNOWN; automatic replay is disabled",
            ));
        }
        result
    }
}
