use super::*;
use areal_runtime_protocol as rt;
#[cfg(test)]
mod tests;

fn validate_process_admission(
    state: &State,
    identity: &str,
    request: &ProcessStart,
    hash: &str,
    concurrent_writes: bool,
) -> Result<Option<Value>> {
    let empty = DesktopState::default();
    let data = state.thread.desktop.as_ref().unwrap_or(&empty);
    if let Some(result) = receipt(
        data,
        identity,
        &request.request_id,
        "areal/process/start",
        hash,
    )? {
        return Ok(Some(result));
    }
    if data.processes.len() >= 128 {
        return Err(Error::Exhausted("process history capacity reached".into()));
    }
    let config = state
        .active
        .as_ref()
        .and_then(|_| state.thread.turns.last())
        .and_then(|turn| turn.configuration.as_ref())
        .unwrap_or(&data.configuration);
    if !matches!(request.lifetime.as_str(), "thread" | "turn") {
        return Err(invalid("lifetime must be thread or turn"));
    }
    if request.lifetime == "thread"
        && !config
            .profile
            .as_ref()
            .is_some_and(|p| p.allow_thread_processes)
    {
        return Err(invalid("profile does not authorize thread resources"));
    }
    if request.lifetime == "thread" && !config.read_only && !concurrent_writes {
        return Err(invalid(
            "thread services require trusted --allow-concurrent-writes to avoid holding the workspace write lock",
        ));
    }
    if request.lifetime == "turn"
        && state
            .active
            .as_ref()
            .is_none_or(|active| active.cancel.is_cancelled())
    {
        return Err(Error::Conflict);
    }
    if request.argv.is_empty()
        || request.argv.len() > 256
        || request.argv.iter().any(|arg| arg.contains('\0'))
        || (request.cols.is_some() != request.rows.is_some())
        || ((request.cols.is_some() || request.rows.is_some()) && !request.tty)
        || request.cols == Some(0)
        || request.rows == Some(0)
    {
        return Err(invalid("invalid process argv or terminal size"));
    }
    Ok(None)
}

fn process_admission_version(state: &State) -> (Option<String>, u64) {
    let turn = state.active.as_ref().map(|active| active.id.clone());
    let revision = state
        .active
        .as_ref()
        .and_then(|_| state.thread.turns.last())
        .and_then(|turn| turn.configuration.as_ref())
        .map(|config| config.revision)
        .or_else(|| {
            state
                .thread
                .desktop
                .as_ref()
                .map(|data| data.configuration.revision)
        })
        .unwrap_or(1);
    (turn, revision)
}

// 仅从可信装配的普通命令预算 Scope 分离 Thread 资源预算；权限或其他资源限制不同则保留原祖先。
fn command_budget_only(command: &rt::ScopeInfo, root: &rt::ScopeInfo) -> bool {
    command.parent_scope_id.as_ref() == Some(&root.scope_id)
        && command.read_roots == root.read_roots
        && command.write_roots == root.write_roots
        && command.network == root.network
        && command.limits.output_bytes == root.limits.output_bytes
        && command.limits.max_processes == root.limits.max_processes
        && command.limits.wall_time_ms <= root.limits.wall_time_ms
}

impl Engine {
    async fn runtime_process_parent(
        &self,
        cell: &Cell,
        thread_lifetime: bool,
    ) -> rt::Result<rt::ScopeInfo> {
        let parent = self.runtime_task_parent(cell).await?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| rt::Error::new(rt::ErrorCode::Unavailable, "Runtime unavailable"))?;
        let client = &runtime.client;
        let mut scope: rt::ScopeInfo = client.call("scope.get", json!({"scopeId":parent})).await?;
        // 子任务及 hooks 的任务 Scope 是权限/生命周期边界，不能因服务需要更长时限而跳过。
        if thread_lifetime
            && cell.state.lock().await.thread.parent_thread_id.is_none()
            && runtime
                .command_scope
                .as_ref()
                .is_some_and(|command| command.scope_id == scope.scope_id)
        {
            let root: rt::ScopeInfo = client
                .call("scope.get", json!({"scopeId":client.info().root_scope_id}))
                .await?;
            if command_budget_only(&scope, &root) {
                scope = root;
            }
        }
        if scope.state != rt::ScopeState::Active {
            return Err(rt::Error::new(
                rt::ErrorCode::ScopeClosed,
                "process parent scope is not active",
            ));
        }
        Ok(scope)
    }

    pub async fn process_start(
        self: &Arc<Self>,
        identity: String,
        request: ProcessStart,
    ) -> Result<Value> {
        self.mutate(move|engine|async move{
            // 启动与交付使用同一准入门；已启动进程仍由 Runtime 计数与收尾证明。
            let _workspace=tokio::select!{biased;
                _=engine.shutdown.cancelled()=>return Err(Error::Closed),
                guard=engine.workspace_gate.clone().read_owned()=>guard,
            };
            let admission = engine.desktop.lifecycle.gate.lock().await;
            if !engine.accepting_work(){return Err(Error::Closed);}
            let runtime=engine.runtime.as_ref().ok_or_else(||invalid("Runtime is not configured"))?;
            let cell=engine.cell(&request.thread_id).await?;
            if cell.state.lock().await.thread.is_read_only_side() { return Err(invalid("SIDE_POLICY_VIOLATION")); }
            let _resources=cell.resource_gate.lock().await;
            let hash=digest(&request)?;
            let cwd=crate::tools::workspace_uri(&request.cwd,&runtime.workspace).map_err(invalid)?;
            if request.timeout_ms.is_some_and(|v|v==0||v>86400000)||request.argv.iter().map(|s|s.len()).sum::<usize>()>64*1024{return Err(invalid("invalid process budget"));}
            let concurrent_writes=runtime.client.info().capabilities["filesystem"]["writeSerialization"]=="filePaths";
            let version={
                let state=cell.state.lock().await;
                if let Some(result)=validate_process_admission(&state,&identity,&request,&hash,concurrent_writes)?{return Ok(result);}
                process_admission_version(&state)
            };
            let permissions=engine.active_permissions(&cell).await.map_err(invalid)?;
            let parent=engine.runtime_process_parent(&cell,request.lifetime=="thread").await.map_err(invalid)?;
            // 已知超额在持久受理前拒绝；受理后的不确定结果仍由原记录查询，不能自动重放。
            if request.timeout_ms.is_some_and(|timeout|timeout>parent.limits.wall_time_ms){
                return Err(invalid(format!("timeoutMs exceeds {} process parent wallTimeMs ({})",request.lifetime,parent.limits.wall_time_ms)));
            }
            let record={
                let mut state=cell.state.lock().await;
                // Scope 查询期间 Turn 可以取消或更换；以当前状态重新检查准入，不回写旧快照。
                if let Some(result)=validate_process_admission(&state,&identity,&request,&hash,concurrent_writes)?{return Ok(result);}
                if process_admission_version(&state)!=version{return Err(Error::Conflict);}
                let turn=state.active.as_ref().map(|a|a.id.clone());
                let mut candidate=state.thread.clone();let data=candidate.desktop.get_or_insert_with(Default::default);
                let record=ManagedProcess{cleanup_attestation:None,id:id(),runtime_epoch:runtime.client.info().runtime_epoch.clone(),scope_operation_id:runtime.client.operation_id(),scope_id:None,operation_id:runtime.client.operation_id(),process_id:None,lifetime:request.lifetime.clone(),turn_id:if request.lifetime=="turn"{turn}else{None},owner:identity.clone(),argv:request.argv.clone(),state:"accepted".into(),cleanup_confirmed:false,error:None,inputs:Vec::new()};
                data.processes.push(record.clone());
                remember(data,&identity,&request.request_id,"areal/process/start",hash,json!({"id":record.id,"runtimeEpoch":record.runtime_epoch}));
                engine.persist(&candidate).await?;state.thread=candidate;
                record
            };
            drop(admission);
            let result=async{
                let scope=runtime.client.create_scope(rt::CreateScope{operation_id:record.scope_operation_id.clone(),parent_scope_id:parent.scope_id,owner:rt::Owner{task_id:request.thread_id.clone(),plugin_instance_id:None},permissions,limits:rt::LimitRequest::default()}).await;
                let scope=match scope {Ok(scope)=>scope,Err(error)=>{
                    if !matches!(error.code,rt::ErrorCode::Unavailable|rt::ErrorCode::CleanupFailed) {engine.edit_process(&cell,&record.id,|p|{p.cleanup_confirmed=true;p.state="failed".into();}).await?;}
                    return Err(invalid(error));
                }};
                engine.edit_process(&cell,&record.id,|p|p.scope_id=Some(scope.scope_id.clone())).await?;
                let process=runtime.client.start(rt::StartProcess{operation_id:record.operation_id.clone(),scope_id:scope.scope_id,argv:request.argv,cwd,env:BTreeMap::new(),tty:request.tty,pipe_stdin:!request.tty,limits:rt::LimitRequest{wall_time_ms:request.timeout_ms,..Default::default()}}).await.map_err(invalid)?;
                engine.edit_process(&cell,&record.id,|p|{p.process_id=Some(process.process_id.clone());p.state="running".into();}).await?;
                if let (Some(cols),Some(rows))=(request.cols,request.rows){runtime.client.resize(rt::ResizeProcess{operation_id:runtime.client.operation_id(),process_id:process.process_id,cols,rows}).await.map_err(invalid)?;}
                Ok::<_,Error>(())
            }.await;
            if let Err(error)=result{
                engine.edit_process(&cell,&record.id,|p|{if !p.cleanup_confirmed{p.state="unknown".into();}p.error=Some(error.to_string());}).await?;
                let _=engine.close_process_scope(&cell,&record.id).await;
                return Err(error);
            }
            Ok(json!({"id":record.id,"runtimeEpoch":record.runtime_epoch}))
        }).await
    }
    async fn close_process_scope(&self, cell: &Cell, id: &str) -> Result<()> {
        let scope = cell
            .state
            .lock()
            .await
            .thread
            .desktop
            .as_ref()
            .and_then(|d| d.processes.iter().find(|p| p.id == id))
            .and_then(|p| p.scope_id.clone())
            .ok_or(Error::Conflict)?;
        self.runtime
            .as_ref()
            .ok_or(Error::Closed)?
            .client
            .close_scope(&scope)
            .await
            .map_err(invalid)?;
        self.edit_process(cell, id, |p| {
            p.cleanup_confirmed = true;
            p.state = "failed".into();
        })
        .await
    }
    pub async fn acknowledge_process_cleanup(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        id: String,
        note: String,
    ) -> Result<Value> {
        self.mutate(move|engine|async move {
            if note.trim().is_empty()||note.len()>4096 {return Err(invalid("external cleanup evidence note required (1..4096 bytes)"));}
            let cell=engine.raw_cell(&thread_id).await?;
            let _resources=cell.resource_gate.lock().await;
            let mut state=cell.state.lock().await;
            let archived=state.thread.desktop.as_ref().is_some_and(|data|data.archived);
            if archived && !state.thread.is_executable_side() {return Err(invalid("THREAD_ARCHIVED"));}
            let mut candidate=if archived {
                engine.store.read_thread(&thread_id).await.map_err(invalid)?
            } else {state.thread.clone()};
            let process=candidate.desktop.as_mut().ok_or(Error::NotFound)?.processes.iter_mut().find(|p|p.id==id).ok_or(Error::NotFound)?;
            if engine.runtime.as_ref().is_some_and(|r|r.client.info().runtime_epoch==process.runtime_epoch) {return Err(invalid("current epoch resources must be closed through Runtime"));}
            process.cleanup_confirmed=true;
            process.cleanup_attestation=Some(CleanupAttestation{identity,note,recorded_at:now()});
            let result=process.clone();
            engine.persist(&candidate).await?;
            state.thread=candidate;
            cell.emit("areal/process/updated",json!({"threadId":thread_id,"process":result}));
            engine.finish_side_close(&cell,&mut state).await?;
            Ok(json!({"cleanupConfirmed":true,"source":"operatorAttestation","executionOutcomeUnchanged":true}))
        }).await
    }
    async fn edit_process(
        &self,
        cell: &Cell,
        id: &str,
        edit: impl FnOnce(&mut ManagedProcess),
    ) -> Result<()> {
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let process = candidate
            .desktop
            .as_mut()
            .ok_or(Error::NotFound)?
            .processes
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or(Error::NotFound)?;
        edit(process);
        let result = process.clone();
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit(
            "areal/process/updated",
            json!({"threadId":state.thread.id,"process":result}),
        );
        Ok(())
    }
    pub async fn processes(&self, thread_id: &str) -> Result<Value> {
        Ok(json!({"data":desktop(&self.read(thread_id,false).await?).processes}))
    }
    async fn managed_process(&self, thread_id: &str, id: &str) -> Result<ManagedProcess> {
        let data = desktop(&self.read(thread_id, false).await?);
        let process = data
            .processes
            .into_iter()
            .find(|p| p.id == id)
            .ok_or(Error::NotFound)?;
        if self
            .runtime
            .as_ref()
            .is_none_or(|r| r.client.info().runtime_epoch != process.runtime_epoch)
        {
            return Err(invalid(
                "STALE_HANDLE: process belongs to a previous Runtime epoch",
            ));
        }
        Ok(process)
    }
    pub async fn process_get(&self, thread_id: &str, id: &str) -> Result<Value> {
        let record = self.managed_process(thread_id, id).await?;
        let status = match &record.process_id {
            Some(id) => json!(
                self.runtime
                    .as_ref()
                    .unwrap()
                    .client
                    .process(id)
                    .await
                    .map_err(invalid)?
            ),
            None => Value::Null,
        };
        Ok(json!({"process":record,"runtime":status}))
    }
    pub async fn process_read(
        &self,
        thread_id: &str,
        id: &str,
        after: Option<String>,
        max_bytes: usize,
        wait_ms: u64,
    ) -> Result<Value> {
        let process = self.managed_process(thread_id, id).await?;
        let process_id = process.process_id.ok_or(Error::Conflict)?;
        self.runtime
            .as_ref()
            .unwrap()
            .client
            .output(rt::ReadOutput {
                process_id,
                after,
                max_bytes,
                wait_ms,
            })
            .await
            .map(|page| json!(page))
            .map_err(invalid)
    }
    pub async fn process_wait(&self, thread_id: &str, id: &str, timeout_ms: u64) -> Result<Value> {
        if timeout_ms > 60000 {
            return Err(invalid("wait timeout must be 0..60000 ms"));
        }
        let process = self.managed_process(thread_id, id).await?;
        let process_id = process.process_id.as_ref().ok_or(Error::Conflict)?;
        let result = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            self.runtime.as_ref().unwrap().client.wait(process_id),
        )
        .await;
        match result {
            Ok(result) => Ok(json!({"timedOut":false,"runtime":result.map_err(invalid)?})),
            Err(_) => Ok(json!({"timedOut":true})),
        }
    }
    pub async fn process_control(
        self: &Arc<Self>,
        identity: String,
        thread_id: String,
        id: String,
        request_id: String,
        action: String,
        args: Value,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            let process = engine.managed_process(&thread_id, &id).await?;
            let process_id = process.process_id.as_ref().ok_or(Error::Conflict)?;
            let client = &engine.runtime.as_ref().unwrap().client;
            let hash = digest(&json!({"id":id,"action":action,"arguments":args}))?;
            let operation_id = client.operation_id();
            {
                let mut state = cell.state.lock().await;
                let mut candidate = state.thread.clone();
                let data = candidate.desktop.as_mut().ok_or(Error::NotFound)?;
                if let Some(result) =
                    receipt(data, &identity, &request_id, "areal/process/control", &hash)?
                {
                    return Ok(result);
                }
                let entry = data
                    .processes
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or(Error::NotFound)?;
                if entry.inputs.len() >= 256 {
                    return Err(Error::Exhausted(
                        "process input journal capacity reached".into(),
                    ));
                }
                entry.inputs.push(ProcessOperation {
                    operation_id: operation_id.clone(),
                    identity: identity.clone(),
                    action: action.clone(),
                    digest: hash.clone(),
                    outcome: "running".into(),
                });
                remember(
                    data,
                    &identity,
                    &request_id,
                    "areal/process/control",
                    hash,
                    json!({"accepted":true,"operationId":operation_id}),
                );
                engine.persist(&candidate).await?;
                state.thread = candidate;
            }
            let result = match action.as_str() {
                "write" => {
                    client
                        .write(rt::ProcessInput {
                            operation_id: operation_id.clone(),
                            process_id: process_id.clone(),
                            data_base64: args["dataBase64"]
                                .as_str()
                                .ok_or_else(|| invalid("dataBase64 required"))?
                                .into(),
                        })
                        .await
                }
                "resize" => {
                    client
                        .resize(rt::ResizeProcess {
                            operation_id: operation_id.clone(),
                            process_id: process_id.clone(),
                            cols: args["cols"]
                                .as_u64()
                                .and_then(|n| u16::try_from(n).ok())
                                .ok_or_else(|| invalid("cols must be 1..65535"))?,
                            rows: args["rows"]
                                .as_u64()
                                .and_then(|n| u16::try_from(n).ok())
                                .ok_or_else(|| invalid("rows must be 1..65535"))?,
                        })
                        .await
                }
                "closeStdin" => {
                    client
                        .close_stdin(rt::CloseStdin {
                            operation_id: operation_id.clone(),
                            process_id: process_id.clone(),
                        })
                        .await
                }
                "terminate" => {
                    async {
                        client.terminate(process_id).await?;
                        client.wait(process_id).await?;
                        client
                            .close_scope(process.scope_id.as_ref().unwrap())
                            .await?;
                        Ok(json!({"accepted":true}))
                    }
                    .await
                }
                _ => return Err(invalid("unknown process control")),
            };
            engine
                .edit_process(&cell, &id, |p| {
                    let entry = p
                        .inputs
                        .iter_mut()
                        .find(|op| op.operation_id == operation_id)
                        .unwrap();
                    entry.outcome = if result.is_ok() {
                        "succeeded"
                    } else if result.as_ref().is_err_and(|e| {
                        matches!(
                            e.code,
                            rt::ErrorCode::Unavailable | rt::ErrorCode::CleanupFailed
                        )
                    }) {
                        "unknown"
                    } else {
                        "failed"
                    }
                    .into();
                    if action == "terminate" && result.is_ok() {
                        p.cleanup_confirmed = true;
                        p.state = "closed".into();
                    }
                })
                .await?;
            result
                .map(|_| json!({"accepted":true,"operationId":operation_id}))
                .map_err(invalid)
        })
        .await
    }
    pub async fn close_resources(self: &Arc<Self>, thread_id: String) -> Result<Value> {
        self.mutate(move |engine| async move {
            let cell = engine.cell(&thread_id).await?;
            engine.close_managed(&cell, None).await?;
            Ok(json!({"cleanupConfirmed":true}))
        })
        .await
    }
    pub(crate) async fn close_managed(&self, cell: &Cell, turn: Option<&str>) -> Result<()> {
        let _resources = cell.resource_gate.lock().await;
        let processes = desktop(&cell.state.lock().await.thread).processes;
        let mut failure = None;
        for process in processes.into_iter().filter(|p| {
            !p.cleanup_confirmed
                && turn
                    .is_none_or(|turn| p.lifetime == "turn" && p.turn_id.as_deref() == Some(turn))
        }) {
            let result = async {
                if let Some(runtime) = &self.runtime {
                    if process.runtime_epoch != runtime.client.info().runtime_epoch {
                        return Err(invalid("old epoch resource requires inspection"));
                    }
                    if let Some(scope) = &process.scope_id {
                        runtime.client.close_scope(scope).await.map_err(invalid)?;
                    } else {
                        return Err(invalid("UNKNOWN process scope requires inspection"));
                    }
                    self.edit_process(cell, &process.id, |p| {
                        p.cleanup_confirmed = true;
                        p.state = "closed".into();
                    })
                    .await?;
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
