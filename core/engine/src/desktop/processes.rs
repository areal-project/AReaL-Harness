use super::*;
use areal_runtime_protocol as rt;

impl Engine {
    pub async fn process_start(
        self: &Arc<Self>,
        identity: String,
        request: ProcessStart,
    ) -> Result<Value> {
        self.mutate(move|engine|async move{
            if !engine.accepting_work(){return Err(Error::Closed);}
            let runtime=engine.runtime.as_ref().ok_or_else(||invalid("Runtime is not configured"))?;
            let cell=engine.cell(&request.thread_id).await?;
            let _resources=cell.resource_gate.lock().await;
            let hash=digest(&request)?;
            let cwd=crate::tools::workspace_uri(&request.cwd,&runtime.workspace).map_err(invalid)?;
            if request.timeout_ms.is_some_and(|v|v==0||v>86400000)||request.argv.iter().map(|s|s.len()).sum::<usize>()>64*1024{return Err(invalid("invalid process budget"));}
            let (record, permissions)={
                let mut state=cell.state.lock().await;
                let mut candidate=state.thread.clone();let data=candidate.desktop.get_or_insert_with(Default::default);
                if let Some(result)=receipt(data,&identity,&request.request_id,"areal/process/start",&hash)?{return Ok(result);}
                if data.processes.len()>=128{return Err(Error::Exhausted("process history capacity reached".into()));}
                let config=state.active.as_ref().and_then(|_|state.thread.turns.last()).and_then(|t|t.configuration.clone()).unwrap_or_else(||data.configuration.clone());
                if !matches!(request.lifetime.as_str(),"thread"|"turn"){return Err(invalid("lifetime must be thread or turn"));}
                if request.lifetime=="thread" && !config.profile.as_ref().is_some_and(|p|p.allow_thread_processes){return Err(invalid("profile does not authorize thread resources"));}
                if request.lifetime=="thread" && !config.read_only && runtime.client.info().capabilities["filesystem"]["writeSerialization"]!="filePaths"{return Err(invalid("thread services require trusted --allow-concurrent-writes to avoid holding the workspace write lock"));}
                let turn=state.active.as_ref().filter(|a|!a.cancel.is_cancelled()).map(|a|a.id.clone());
                if request.lifetime=="turn" && turn.is_none(){return Err(Error::Conflict);}
                if request.argv.is_empty() || request.argv.len()>256 || request.argv.iter().any(|a|a.contains('\0')) || (request.cols.is_some()!=request.rows.is_some()) || ((request.cols.is_some() || request.rows.is_some())&&!request.tty) || request.cols==Some(0) || request.rows==Some(0){return Err(invalid("invalid process argv or terminal size"));}
                let record=ManagedProcess{cleanup_attestation:None,id:id(),runtime_epoch:runtime.client.info().runtime_epoch.clone(),scope_operation_id:runtime.client.operation_id(),scope_id:None,operation_id:runtime.client.operation_id(),process_id:None,lifetime:request.lifetime.clone(),turn_id:if request.lifetime=="turn"{turn}else{None},owner:identity.clone(),argv:request.argv.clone(),state:"accepted".into(),cleanup_confirmed:false,error:None,inputs:Vec::new()};
                data.processes.push(record.clone());
                remember(data,&identity,&request.request_id,"areal/process/start",hash,json!({"id":record.id,"runtimeEpoch":record.runtime_epoch}));
                let permissions=rt::PermissionRequest{write_roots:config.read_only.then(Vec::new),network:if config.read_only {rt::NetworkRequest::Deny}else{rt::NetworkRequest::Inherit},..Default::default()};
                engine.persist(&candidate).await?;state.thread=candidate;
                (record,permissions)
            };
            let result=async{
                let scope=runtime.client.create_scope(rt::CreateScope{operation_id:record.scope_operation_id.clone(),parent_scope_id:runtime.client.info().root_scope_id.clone(),owner:rt::Owner{task_id:request.thread_id.clone(),plugin_instance_id:None},permissions,limits:rt::LimitRequest::default()}).await;
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
            let cell=engine.cell(&thread_id).await?;
            let _resources=cell.resource_gate.lock().await;
            let process=desktop(&cell.state.lock().await.thread).processes.into_iter().find(|p|p.id==id).ok_or(Error::NotFound)?;
            if engine.runtime.as_ref().is_some_and(|r|r.client.info().runtime_epoch==process.runtime_epoch) {return Err(invalid("current epoch resources must be closed through Runtime"));}
            engine.edit_process(&cell,&id,|p|{p.cleanup_confirmed=true;p.cleanup_attestation=Some(CleanupAttestation{identity,note,recorded_at:now()});}).await?;
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
        for process in processes.into_iter().filter(|p| {
            !p.cleanup_confirmed
                && turn
                    .is_none_or(|turn| p.lifetime == "turn" && p.turn_id.as_deref() == Some(turn))
        }) {
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
        }
        Ok(())
    }
}
