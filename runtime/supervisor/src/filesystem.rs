use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

// Leave room for RPC IDs and operation.get's retained-result metadata.
pub(super) const MAX_HELPER_RESPONSE_BYTES: usize = MAX_FRAME_BYTES - 4096;

impl Supervisor {
    pub async fn filesystem(self: &Arc<Self>, request: FileRequest) -> Result<Value> {
        self.validate_operation(&request.operation_id)?;
        self.check_handle(&request.scope_id, "scope")?;
        let digest = digest("fs.execute", &request)?;
        let mut completion = {
            let mut state = self.registry.lock().unwrap();
            if let Some(existing) = replay(&state, &request.operation_id, digest)? {
                existing
            } else {
                self.admit_operation(&state)?;
                self.validate_paths(&state, &request.scope_id)?;
                let scope = state.scopes.get(&request.scope_id).ok_or_else(not_found)?;
                ensure_active(scope)?;
                let helper = self.config.file_helper.clone().ok_or_else(|| {
                    Error::new(ErrorCode::Unsupported, "file helper is not configured")
                })?;
                let path = self.workspace.file_path(request.command.path())?;
                if request.command.writes()
                    && self
                        .config
                        .read_only_paths
                        .iter()
                        .any(|root| path.starts_with(root) || root.starts_with(&path))
                {
                    return Err(denied("public inputs are read-only"));
                }
                let roots = if request.command.writes() {
                    &scope.writes
                } else {
                    &scope.reads
                };
                let root = roots
                    .iter()
                    .filter(|root| path.starts_with(root))
                    .max_by_key(|root| root.components().count())
                    .ok_or_else(|| denied("file path is outside scope permissions"))?;
                let mut command = request.command.clone();
                *command.path_mut() = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .ok_or_else(|| invalid("path must be UTF-8"))?
                    .to_owned();
                let envelope = FileHelperRequest {
                    root: root
                        .to_str()
                        .ok_or_else(|| invalid("root must be UTF-8"))?
                        .into(),
                    command,
                };
                let process = StartProcess {
                    operation_id: handle(&self.epoch, "op"),
                    scope_id: request.scope_id.clone(),
                    argv: vec![
                        helper
                            .to_str()
                            .ok_or_else(|| invalid("helper path must be UTF-8"))?
                            .into(),
                        serde_json::to_string(&envelope)
                            .map_err(|_| invalid("invalid helper request"))?,
                    ],
                    cwd: self.workspace.uri(root),
                    env: BTreeMap::new(),
                    tty: false,
                    pipe_stdin: false,
                    limits: LimitRequest::default(),
                };
                let operation = new_operation(request.operation_id.clone(), digest);
                let receiver = operation.complete.subscribe();
                state
                    .operations
                    .insert(request.operation_id.clone(), operation);
                let runtime = self.clone();
                self.tasks.spawn(async move {
                    runtime
                        .registry
                        .lock()
                        .unwrap()
                        .operations
                        .get_mut(&request.operation_id)
                        .unwrap()
                        .info
                        .state = OperationState::Running;
                    let result = std::panic::AssertUnwindSafe(runtime.file_run(
                        process,
                        FileHelper {
                            executable: helper,
                            path,
                            writes: request.command.writes(),
                            read_for_history: matches!(
                                &request.command,
                                FileCommand::ReadForHistory { .. }
                            ),
                        },
                        matches!(request.command, FileCommand::ReadImage { .. }),
                    ))
                    .catch_unwind()
                    .await
                    .unwrap_or_else(|_| {
                        Err(unavailable(
                            "file supervisor panicked; inspect workspace before retrying",
                        ))
                    });
                    let status = match &result {
                        Ok(_) => OperationState::Succeeded,
                        Err(error)
                            if matches!(
                                error.code,
                                ErrorCode::Unavailable | ErrorCode::CleanupFailed
                            ) =>
                        {
                            OperationState::Unknown
                        }
                        Err(error) if error.code == ErrorCode::ScopeClosed => {
                            OperationState::Cancelled
                        }
                        Err(_) => OperationState::Failed,
                    };
                    complete_operation(
                        &mut runtime.registry.lock().unwrap(),
                        &request.operation_id,
                        result,
                        status,
                    );
                    runtime.changed();
                });
                receiver
            }
        };
        loop {
            if let Some(result) = completion.borrow().clone() {
                return result;
            }
            completion
                .changed()
                .await
                .map_err(|_| unavailable("file operation result lost"))?;
        }
    }

    async fn file_run(
        self: &Arc<Self>,
        process: StartProcess,
        helper: FileHelper,
        image_view: bool,
    ) -> Result<Value> {
        let writes = helper.writes;
        let response_limit = if image_view {
            MAX_IMAGE_RESPONSE_BYTES
        } else {
            MAX_HELPER_RESPONSE_BYTES
        };
        let process = self.start_inner(process, Some(helper), true).await?;
        let mut cursor = None;
        let mut bytes = Vec::new();
        let mut stderr = Vec::new();
        let mut incomplete = false;
        loop {
            let page = self
                .output(ReadOutput {
                    process_id: process.process_id.clone(),
                    after: cursor,
                    max_bytes: MAX_READ_BYTES,
                    wait_ms: 1000,
                })
                .await?;
            incomplete |= page.gap || page.truncated;
            for chunk in page.chunks {
                let stream = chunk.stream;
                let chunk = STANDARD
                    .decode(chunk.data_base64)
                    .map_err(|_| unavailable("invalid helper output"))?;
                if stream == OutputStream::Stdout {
                    // The helper returns a JSON envelope containing base64, not
                    // raw file bytes. Its complete response must fit one RPC frame.
                    if bytes.len() + chunk.len() > response_limit {
                        incomplete = true;
                    } else {
                        bytes.extend(chunk);
                    }
                } else if stream == OutputStream::Stderr {
                    stderr.extend(
                        chunk
                            .into_iter()
                            .take(2048usize.saturating_sub(stderr.len())),
                    );
                }
            }
            cursor = Some(page.next_cursor);
            if page.closed {
                break;
            }
        }
        let info = self.wait_process(&process.process_id).await?;
        if image_view
            && info.state == ProcessState::Exited
            && info.cleanup_confirmed
            && info.stop_reason.as_deref() == Some("scope revoked")
        {
            return Err(Error::new(
                ErrorCode::ScopeClosed,
                "image preprocessing cancelled with scope; no view was committed",
            ));
        }
        if incomplete || info.stop_reason.is_some() {
            // 只读助手已回收且确定耗尽输出额度时，失败结果已知；写入丢失确认仍必须保留 UNKNOWN。
            if !writes
                && info.state == ProcessState::Exited
                && info.cleanup_confirmed
                && info.stop_reason.as_deref() == Some("outputBytes exceeded")
            {
                let mut error =
                    exhausted("read-only file output budget exceeded; request a smaller result");
                error.details = Some(serde_json::json!({"reason":"FILE_OUTPUT_LIMIT_EXCEEDED",
                    "processId":info.process_id,"cleanupConfirmed":true,"writeMayHaveOccurred":false}));
                return Err(error);
            }
            return Err(unavailable(
                "file operation output or completion is uncertain; inspect before retrying",
            ));
        }
        if info.exit_code != Some(0) {
            let mut error =
                unavailable("file helper exited abnormally; outcome requires inspection");
            error.details = Some(
                serde_json::json!({"processId":info.process_id,"exitCode":info.exit_code,
                "signal":info.signal,"sandboxDenied":info.sandbox_denied,"stderr":String::from_utf8_lossy(&stderr)}),
            );
            return Err(error);
        }
        let mut envelope: serde_json::Map<String, Value> = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid file helper response"))?;
        if envelope.len() != 1 {
            return Err(unavailable("ambiguous file helper response"));
        }
        if let Some(value) = envelope.remove("result") {
            if image_view {
                // 大视图仍通过既有有界输出页传递，fs.execute 的单帧上限不变。
                return Ok(
                    serde_json::json!({"imageOutput":{"processId":process.process_id,"bytes":bytes.len(),
                    "encoding":"file-helper-json","scopeId":info.scope_id,"exitCode":info.exit_code}}),
                );
            }
            return Ok(value);
        }
        match envelope.remove("error") {
            Some(error) => {
                Err(decode(error).map_err(|_| unavailable("invalid file helper error"))?)
            }
            None => Err(unavailable("missing file helper result")),
        }
    }
}
