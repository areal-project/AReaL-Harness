use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(serde::Serialize)]
enum Action {
    Write(String),
    Resize(u16, u16),
    Close,
}
impl Supervisor {
    pub async fn write(self: &Arc<Self>, request: ProcessInput) -> Result<Value> {
        self.input_control(
            request.operation_id,
            request.process_id,
            Action::Write(request.data_base64),
        )
        .await
    }
    pub async fn resize(self: &Arc<Self>, request: ResizeProcess) -> Result<Value> {
        if request.cols == 0 || request.rows == 0 {
            return Err(invalid("terminal dimensions must be positive"));
        }
        self.input_control(
            request.operation_id,
            request.process_id,
            Action::Resize(request.cols, request.rows),
        )
        .await
    }
    pub async fn close_stdin(self: &Arc<Self>, request: CloseStdin) -> Result<Value> {
        self.input_control(request.operation_id, request.process_id, Action::Close)
            .await
    }
    async fn input_control(
        self: &Arc<Self>,
        operation_id: String,
        process_id: String,
        action: Action,
    ) -> Result<Value> {
        self.validate_operation(&operation_id)?;
        self.check_handle(&process_id, "process")?;
        let digest = digest_bounded("process.input", &(&process_id, &action), 124 * 1024)?;
        let mut completion = {
            let mut state = self.registry.lock().unwrap();
            if let Some(existing) = replay(&state, &operation_id, digest)? {
                existing
            } else {
                self.admit_operation(&state)?;
                let bytes = if let Action::Write(data) = &action {
                    if data.len() > MAX_FILE_CHUNK.div_ceil(3) * 4 {
                        return Err(invalid("stdin write exceeds 64 KiB"));
                    }
                    let bytes = STANDARD
                        .decode(data)
                        .map_err(|_| invalid("invalid base64 stdin"))?;
                    if bytes.is_empty() || bytes.len() > MAX_FILE_CHUNK {
                        return Err(invalid("stdin write must contain 1..65536 bytes"));
                    }
                    bytes
                } else {
                    if !self.backend.supports_terminal_control() {
                        return Err(Error::new(
                            ErrorCode::Unsupported,
                            "backend does not support terminal controls",
                        ));
                    }
                    Vec::new()
                };
                let process = state.processes.get(&process_id).ok_or_else(not_found)?;
                ensure_active(&state.scopes[&process.info.scope_id])?;
                if !process.accepts_stdin {
                    return Err(Error::new(
                        ErrorCode::Unsupported,
                        "process was started without stdin",
                    ));
                }
                if process.info.state != ProcessState::Running {
                    return Err(Error::new(ErrorCode::ScopeClosed, "process is not running"));
                }
                let operation = new_operation(operation_id.clone(), digest);
                let receiver = operation.complete.subscribe();
                state.operations.insert(operation_id.clone(), operation);
                let runtime = self.clone();
                self.tasks.spawn(async move {
                    runtime
                        .registry
                        .lock()
                        .unwrap()
                        .operations
                        .get_mut(&operation_id)
                        .unwrap()
                        .info
                        .state = OperationState::Running;
                    let result = match tokio::time::timeout(
                        Duration::from_secs(5),
                        std::panic::AssertUnwindSafe(async {
                            match action {
                                Action::Write(_) => {
                                    runtime
                                        .backend
                                        .write(&process_id, &operation_id, &bytes)
                                        .await
                                }
                                Action::Resize(cols, rows) => {
                                    runtime.backend.resize(&process_id, cols, rows).await
                                }
                                Action::Close => runtime.backend.close_stdin(&process_id).await,
                            }
                        })
                        .catch_unwind(),
                    )
                    .await
                    {
                        Ok(Ok(result)) => result.map(|_| json!({"accepted":true})),
                        _ => Err(unavailable(
                            "input backend panicked or timed out; input outcome is UNKNOWN",
                        )),
                    };
                    let status = match &result {
                        Ok(_) => OperationState::Succeeded,
                        Err(error) if error.code == ErrorCode::Unavailable => {
                            OperationState::Unknown
                        }
                        Err(_) => OperationState::Failed,
                    };
                    complete_operation(
                        &mut runtime.registry.lock().unwrap(),
                        &operation_id,
                        result,
                        status,
                    );
                    if status == OperationState::Unknown {
                        let _ = runtime.revoke(&runtime.root);
                        let _ = runtime.backend.shutdown().await;
                    }
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
                .map_err(|_| unavailable("input result lost"))?;
        }
    }
}
