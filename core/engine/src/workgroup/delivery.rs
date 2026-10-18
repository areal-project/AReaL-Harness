//! 交付只消费已冻结候选，通过 Runtime 执行写入；持久意图不能当成成功回执。
use super::{Tree, tree};
use anyhow::{Context, Result, ensure};
use areal_runtime_protocol as rt;
use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

pub(super) struct Bundle {
    pub owner: String,
    pub workspace: PathBuf,
    pub journal: PathBuf,
    pub base: Tree,
    pub candidate: Tree,
    pub verified: bool,
    pub strict: bool,
    pub cancel: tokio_util::sync::CancellationToken,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u32,
    thread_id: String,
    group_id: String,
    source_head: String,
    head: String,
    baseline: String,
    verified: bool,
    verification: Option<super::Check>,
    status: String,
    applied_paths: Vec<String>,
    steps: Vec<Step>,
    error: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    path: String,
    operation_id: String,
    request_sha256: String,
    command: Value,
    kind: String,
    state: String,
    receipt: Option<Value>,
    error: Option<String>,
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn invalid(error: impl std::fmt::Display) -> crate::Error {
    crate::Error::Invalid(error.to_string())
}

async fn delivery_guard(
    engine: &crate::Engine,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> crate::Result<tokio::sync::OwnedRwLockWriteGuard<()>> {
    match cancel {
        Some(cancel) => tokio::select! { biased;
            _ = cancel.cancelled() => Err(crate::Error::Closed),
            _ = engine.shutdown.cancelled() => Err(crate::Error::Closed),
            guard = engine.workspace_delivery_guard() => Ok(guard),
        },
        None => tokio::select! { biased;
            _ = engine.shutdown.cancelled() => Err(crate::Error::Closed),
            guard = engine.workspace_delivery_guard() => Ok(guard),
        },
    }
}

async fn snapshot(path: &Path) -> Result<Tree> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || tree::snapshot(&path)).await?
}
async fn save(path: &Path, journal: &Journal) -> Result<()> {
    let bytes = serde_json::to_vec(journal)?;
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let parent = path.parent().context("delivery journal has no parent")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })
    .await?
}
async fn load(path: &Path) -> Result<Option<Journal>> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || -> Result<_> {
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    })
    .await?
}
fn projection(journal: &Journal, workspace_matches: Option<bool>) -> Value {
    let mut path_bytes = 0;
    let paths = journal
        .applied_paths
        .iter()
        .take(32)
        .take_while(|path| {
            path_bytes += path.len();
            path_bytes <= 6000
        })
        .collect::<Vec<_>>();
    let last = journal.steps.last().map(|step| {
        json!({"path":step.path,
        "operationId":step.operation_id,"kind":step.kind,"state":step.state,
        "requestSha256":step.request_sha256,"uploadId":step.command.get("uploadId"),
        "offset":step.command.get("offset"),"receipt":step.receipt,
        "error":step.error.as_ref().map(|error| error.chars().take(1024).collect::<String>())})
    });
    json!({"groupId":journal.group_id,"sourceHead":journal.source_head,"head":journal.head,"baseline":journal.baseline,"status":journal.status,
        "applied":journal.status=="applied","verified":journal.verified,
        "verification":journal.verification.as_ref().map(|check|json!({"treeHash":check.tree_hash,"passed":check.passed,"output":check.output.chars().take(1024).collect::<String>()})),
        "workspaceMatches":workspace_matches,"appliedFiles":journal.applied_paths.len(),
        "appliedPaths":paths,"pathsTruncated":paths.len()!=journal.applied_paths.len(),
        "steps":journal.steps.len(),"lastOperation":last,
        "error":journal.error.as_ref().map(|error|error.chars().take(1024).collect::<String>()),
        "retryPolicy":"inspectOnly"})
}

fn changed(bundle: &Bundle) -> Vec<String> {
    bundle
        .base
        .keys()
        .chain(bundle.candidate.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| bundle.base.get(*path) != bundle.candidate.get(*path))
        .cloned()
        .collect()
}

async fn preflight(workspace: &Path, base: &Tree, candidate: &Tree) -> Result<()> {
    let paths = base
        .keys()
        .chain(candidate.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| base.get(*path) != candidate.get(*path))
        .map(|path| (path.clone(), candidate.contains_key(path)))
        .collect::<Vec<_>>();
    let workspace = workspace.to_owned();
    tokio::task::spawn_blocking(move || -> Result<()> {
        for (path, exists_after) in paths {
            // Runtime v0 使用未编码 URI；整组先确认可表达，避免前面文件已提交后才拒绝。
            rt::workspace_relative_path(&format!("/{path}")).with_context(|| {
                format!("artifact path cannot be represented by Runtime v0: {path}")
            })?;
            if exists_after {
                // 这里只预检当前类型；snapshot 与 Runtime 各自保留路径约束，外部修改仍可能冲突。
                match std::fs::symlink_metadata(workspace.join(&path)) {
                    Ok(metadata) => ensure!(
                        !metadata.is_dir(),
                        "artifact delivery cannot replace a directory with a file: {path}"
                    ),
                    // 文件→目录时，较短的旧文件路径会先被删除，再创建父目录。
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                        ) => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(())
    })
    .await?
}

#[async_trait]
trait Files: Send + Sync {
    fn operation_id(&self) -> String;
    async fn execute(&self, request: rt::FileRequest) -> rt::Result<Value>;
}
#[async_trait]
impl Files for areal_runtime_client::Client {
    fn operation_id(&self) -> String {
        self.operation_id()
    }
    async fn execute(&self, request: rt::FileRequest) -> rt::Result<Value> {
        self.filesystem(request).await
    }
}

async fn execute(
    files: &dyn Files,
    scope: &str,
    bundle: &Bundle,
    journal: &mut Journal,
    path: &str,
    command: rt::FileCommand,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<bool> {
    if bundle.cancel.is_cancelled() || cancel.is_some_and(|token| token.is_cancelled()) {
        journal.status = "partial".into();
        journal.error = Some(
            "delivery cancelled after settling prior operations; no further writes started".into(),
        );
        save(&bundle.journal, journal).await?;
        return Ok(false);
    }
    let operation_id = files.operation_id();
    let request = rt::FileRequest {
        operation_id: operation_id.clone(),
        scope_id: scope.to_owned(),
        command,
    };
    let expected_receipt = match &request.command {
        rt::FileCommand::StageFileChunk {
            upload_id,
            offset,
            data_base64,
            ..
        } => {
            json!({"uploadId":upload_id,"nextOffset":offset + STANDARD.decode(data_base64)?.len() as u64})
        }
        rt::FileCommand::CommitFile {
            sha256, executable, ..
        } => json!({"sha256":sha256,"executable":executable}),
        rt::FileCommand::RemoveFile { .. } => json!({"removed":true}),
        _ => anyhow::bail!("unsupported delivery operation"),
    };
    let mut intent = serde_json::to_value(&request.command)?;
    if let Some(object) = intent.as_object_mut() {
        object.remove("dataBase64");
    }
    let encoded = serde_json::to_vec(&request)?;
    let kind = serde_json::to_value(&request.command)?["kind"]
        .as_str()
        .unwrap()
        .to_owned();
    journal.steps.push(Step {
        path: path.to_owned(),
        operation_id,
        request_sha256: sha(&encoded),
        command: intent,
        kind,
        state: "pending".into(),
        receipt: None,
        error: None,
    });
    save(&bundle.journal, journal).await?;
    let result = files.execute(request).await.and_then(|receipt| {
        if expected_receipt
            .as_object()
            .unwrap()
            .iter()
            .all(|(key, value)| receipt.get(key) == Some(value))
        {
            Ok(receipt)
        } else {
            Err(rt::Error::new(
                rt::ErrorCode::Unavailable,
                "delivery receipt does not match the persisted operation",
            ))
        }
    });
    let step = journal.steps.last_mut().unwrap();
    match result {
        Ok(receipt) => {
            step.state = "succeeded".into();
            step.receipt = Some(receipt);
        }
        Err(error) => {
            let known = matches!(
                error.code,
                rt::ErrorCode::Conflict
                    | rt::ErrorCode::InvalidArgument
                    | rt::ErrorCode::PermissionDenied
                    | rt::ErrorCode::NotFound
                    | rt::ErrorCode::ResourceExhausted
                    | rt::ErrorCode::Unsupported
            );
            step.state = if known { "failed" } else { "unknown" }.into();
            step.error = Some(error.to_string());
            journal.status = if !known {
                "unknown"
            } else if journal.applied_paths.is_empty() {
                "conflict"
            } else {
                "partial"
            }
            .into();
            journal.error = Some(error.to_string());
            save(&bundle.journal, journal).await?;
            return Ok(false);
        }
    }
    save(&bundle.journal, journal).await?;
    Ok(true)
}

async fn inspect(
    bundle: &Bundle,
    mut journal: Journal,
    thread: &str,
    group: &str,
) -> Result<Value> {
    ensure!(
        journal.version == 2
            && journal.thread_id == thread
            && journal.group_id == group
            && journal.source_head == tree::digest(&bundle.candidate),
        "delivery intent mismatch"
    );
    if matches!(journal.status.as_str(), "preparing" | "applying") {
        // 重启后无法从源码相等推断旧操作已结算；只回读，不重放也不升级成功。
        journal.status = "unknown".into();
        journal.error = Some(
            "delivery interrupted; inspect durable receipts and workspace; no automatic replay"
                .into(),
        );
        save(&bundle.journal, &journal).await?;
    }
    let matches = snapshot(&bundle.workspace)
        .await
        .ok()
        .map(|tree| tree::digest(&tree) == journal.head);
    Ok(projection(&journal, matches))
}

#[async_trait]
trait Verifier: Send + Sync {
    async fn verify(
        &self,
        candidate: Tree,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Option<super::Check>>;
}
struct ServiceVerifier<'a> {
    service: &'a super::service::Service,
    group: &'a str,
}
#[async_trait]
impl Verifier for ServiceVerifier<'_> {
    async fn verify(
        &self,
        candidate: Tree,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Option<super::Check>> {
        self.service
            .verify_delivery(self.group, candidate, cancel)
            .await
    }
}

async fn deliver(
    files: &dyn Files,
    scope: &str,
    bundle: &Bundle,
    thread: &str,
    group: &str,
    cancel: Option<&tokio_util::sync::CancellationToken>,
    verifier: &dyn Verifier,
) -> Result<Value> {
    if let Some(journal) = load(&bundle.journal).await? {
        return inspect(bundle, journal, thread, group).await;
    }
    let mut journal = Journal {
        version: 2,
        thread_id: thread.into(),
        group_id: group.into(),
        source_head: tree::digest(&bundle.candidate),
        head: tree::digest(&bundle.candidate),
        baseline: tree::digest(&bundle.base),
        verified: bundle.verified,
        verification: None,
        status: "preparing".into(),
        applied_paths: vec![],
        steps: vec![],
        error: None,
    };
    let composed = async {
        let current = snapshot(&bundle.workspace).await?;
        let candidate = tree::compose(&current, &bundle.base, &bundle.candidate, &changed(bundle))?;
        preflight(&bundle.workspace, &current, &candidate).await?;
        let root = bundle
            .journal
            .parent()
            .context("delivery journal has no parent")?
            .to_owned();
        let stored = candidate.clone();
        tokio::task::spawn_blocking(move || tree::store(&root, &stored)).await??;
        Ok::<_, anyhow::Error>((current, candidate))
    }
    .await;
    let (current, candidate) = match composed {
        Ok(composed) => composed,
        Err(error) => {
            journal.status = "conflict".into();
            journal.error = Some(format!(
                "candidate cannot be prepared for delivery; no files applied: {error}"
            ));
            save(&bundle.journal, &journal).await?;
            return Ok(projection(&journal, Some(false)));
        }
    };
    journal.baseline = tree::digest(&current);
    journal.head = tree::digest(&candidate);
    // 原检查只证明原候选。与其他组的改动组合后，可信检查必须针对同一个冻结摘要重跑。
    let needs_verification = bundle.strict && journal.head != journal.source_head;
    if needs_verification {
        journal.verified = false;
    }
    save(&bundle.journal, &journal).await?;
    if needs_verification {
        let verification_cancel = cancel.map(|token| token.child_token()).unwrap_or_default();
        let verification = verifier.verify(candidate.clone(), verification_cancel.clone());
        tokio::pin!(verification);
        // 取消组合树验收仍等待执行器清理，不能丢弃 future 后宣称资源已释放。
        let check = tokio::select! { biased;
            _ = bundle.cancel.cancelled() => {
                verification_cancel.cancel();
                verification.await
            },
            result = &mut verification => result,
        };
        match check {
            Ok(Some(check)) if check.passed && check.tree_hash == journal.head => {
                journal.verified = true;
                journal.verification = Some(check);
            }
            outcome => {
                journal.status = "conflict".into();
                journal.error = Some(match outcome {
                    Ok(check) => {
                        journal.verification = check;
                        "composed candidate did not pass trusted acceptance; no files applied"
                            .into()
                    }
                    Err(error) => {
                        if error.downcast_ref::<super::CleanupFailure>().is_some() {
                            journal.status = "unknown".into();
                        }
                        format!("composed candidate acceptance failed; no files applied: {error}")
                    }
                });
                save(&bundle.journal, &journal).await?;
                return Ok(projection(&journal, None));
            }
        }
    }
    // 后续条件写入和最终核对均绑定组合树；重试只读取已持久化的 sourceHead/head。
    let prepared = Bundle {
        owner: bundle.owner.clone(),
        workspace: bundle.workspace.clone(),
        journal: bundle.journal.clone(),
        base: current,
        candidate,
        verified: journal.verified,
        strict: bundle.strict,
        cancel: bundle.cancel.clone(),
    };
    let bundle = &prepared;
    if !snapshot(&bundle.workspace)
        .await
        .as_ref()
        .is_ok_and(|current| current == &bundle.base)
    {
        journal.status = "conflict".into();
        journal.error =
            Some("workspace changed during candidate acceptance; no files applied".into());
        save(&bundle.journal, &journal).await?;
        return Ok(projection(&journal, Some(false)));
    }
    journal.status = "applying".into();
    save(&bundle.journal, &journal).await?;
    for path in changed(bundle) {
        let uri = format!("workspace://repo/{path}");
        let before = bundle.base.get(&path);
        let expected = before.map_or(rt::ExpectedFile::Absent, |file| rt::ExpectedFile::Sha256 {
            value: sha(&file.bytes),
        });
        if let Some(after) = bundle.candidate.get(&path) {
            let upload_id = uuid::Uuid::new_v4().to_string();
            let chunks: Vec<&[u8]> = if after.bytes.is_empty() {
                vec![&[]]
            } else {
                after.bytes.chunks(rt::MAX_FILE_CHUNK).collect()
            };
            for (index, chunk) in chunks.into_iter().enumerate() {
                let command = rt::FileCommand::StageFileChunk {
                    path: uri.clone(),
                    upload_id: upload_id.clone(),
                    offset: (index * rt::MAX_FILE_CHUNK) as u64,
                    data_base64: STANDARD.encode(chunk),
                };
                if !execute(files, scope, bundle, &mut journal, &path, command, cancel).await? {
                    return Ok(projection(&journal, None));
                }
            }
            let command = rt::FileCommand::CommitFile {
                path: uri,
                upload_id,
                expected,
                expected_executable: before.map(|file| file.executable),
                sha256: sha(&after.bytes),
                executable: after.executable,
            };
            if !execute(files, scope, bundle, &mut journal, &path, command, cancel).await? {
                return Ok(projection(&journal, None));
            }
        } else {
            let before = before.context("deleted artifact has no baseline")?;
            let command = rt::FileCommand::RemoveFile {
                path: uri,
                expected_sha256: sha(&before.bytes),
                expected_executable: before.executable,
            };
            if !execute(files, scope, bundle, &mut journal, &path, command, cancel).await? {
                return Ok(projection(&journal, None));
            }
        }
        journal.applied_paths.push(path);
        save(&bundle.journal, &journal).await?;
    }
    let matches = snapshot(&bundle.workspace)
        .await
        .ok()
        .map(|tree| tree == bundle.candidate);
    if matches == Some(true) {
        journal.status = "applied".into();
    } else {
        journal.status = "partial".into();
        journal.error=Some("workspace differs from the accepted candidate after delivery; inspect before continuing".into());
    }
    save(&bundle.journal, &journal).await?;
    Ok(projection(&journal, matches))
}

impl crate::Engine {
    pub(crate) async fn workgroup_delivery_status(
        &self,
        group_id: &str,
        automatic: bool,
    ) -> crate::Result<Value> {
        let service = self.execution_workgroups(automatic)?;
        let path = service.delivery_journal(group_id).await.map_err(invalid)?;
        Ok(load(&path)
            .await
            .map_err(invalid)?
            .map_or(Value::Null, |journal| projection(&journal, None)))
    }

    pub async fn apply_workgroup_artifact(
        self: &Arc<Self>,
        thread_id: &str,
        group_id: &str,
        expected_head: &str,
    ) -> crate::Result<Value> {
        // 无关所有者的组不可通过另一个 service 绕过检查。
        if let Ok(service) = self.execution_workgroups(false)
            && service.read(group_id, None).await.is_ok()
        {
            return self
                .apply_workgroup_artifact_from(thread_id, group_id, expected_head, false)
                .await;
        }
        self.apply_workgroup_artifact_from(thread_id, group_id, expected_head, true)
            .await
    }
    pub(crate) async fn apply_workgroup_artifact_from(
        self: &Arc<Self>,
        thread_id: &str,
        group_id: &str,
        expected_head: &str,
        automatic: bool,
    ) -> crate::Result<Value> {
        let (thread_id, group_id, expected_head) = (
            thread_id.to_owned(),
            group_id.to_owned(),
            expected_head.to_owned(),
        );
        self.mutate(move |engine| async move {
            let service = engine.execution_workgroups(automatic)?;
            let bundle = service.delivery_bundle(&group_id, &expected_head, automatic)
                .await.map_err(invalid)?;
            let cell = engine.cell(&thread_id).await?;
            let runtime = engine.runtime.as_ref()
                .ok_or_else(|| invalid("artifact delivery requires Runtime"))?;
            let (active, legacy_owner, writable) = {
                let state = cell.state.lock().await;
                let config = state.thread.turns.last().and_then(|turn| turn.configuration.as_ref())
                    .or_else(|| state.thread.desktop.as_ref().map(|data| &data.configuration));
                let writable = runtime.writable && !config.is_some_and(|config| config.read_only
                    || config.tool_allowlist.as_ref().is_some_and(|tools| !tools.iter().any(|tool| tool == "fs_write")));
                let legacy_owner = bundle.owner == format!("thread:{thread_id}")
                    || state.thread.turns.iter().any(|turn| bundle.owner == format!("{thread_id}/{}", turn.id));
                if Path::new(&state.thread.cwd).canonicalize().map_err(invalid)? != bundle.workspace
                    || runtime.workspace.canonicalize().map_err(invalid)? != bundle.workspace {
                    return Err(invalid("workgroup and parent Runtime must share the same workspace"));
                }
                (state.active.as_ref().map(|active| (active.id.clone(), active.cancel.clone())), legacy_owner, writable)
            };
            if !legacy_owner && !engine.owns_execution_group(&thread_id, &group_id, automatic, &bundle.owner).await? {
                return Err(invalid("workgroup belongs to another parent thread"));
            }
            {
                let _guard = delivery_guard(&engine, active.as_ref().map(|(_, cancel)| cancel)).await?;
                if let Some(journal) = load(&bundle.journal).await.map_err(invalid)? {
                    return inspect(&bundle, journal, &thread_id, &group_id).await.map_err(invalid);
                }
            }
            if bundle.cancel.is_cancelled() || engine.execution_group_cancel_requested(&thread_id, &group_id, automatic).await? {
                return Ok(json!({"status":"cancelled","applied":false,"groupId":group_id,"head":expected_head}));
            }
            let Some((turn_id, cancel)) = active else {
                return Ok(json!({"status":"requiresActiveTurn","applied":false,"groupId":group_id,"head":expected_head}));
            };
            if let Some(error) = engine.goal_tool_guard(&cell, "fs_write").await.map_err(invalid)? {
                return Err(invalid(error));
            }
            if !writable { return Err(invalid("parent permissions do not authorize artifact delivery")); }
            if runtime.client.info().capabilities["filesystem"]["artifactDelivery"] != true {
                return Err(invalid("Runtime does not support artifact delivery"));
            }
            let changes = changed(&bundle).into_iter().map(|path| json!({
                "path":path, "beforeSha256":bundle.base.get(&path).map(|file|sha(&file.bytes)),
                "afterSha256":bundle.candidate.get(&path).map(|file|sha(&file.bytes)),
                "executable":bundle.candidate.get(&path).map(|file|file.executable),
                "remove":!bundle.candidate.contains_key(&path)
            })).collect::<Vec<_>>();
            let approval = json!({"operation":"applyArtifact","groupId":group_id,"head":expected_head,
                "baseline":tree::digest(&bundle.base),"changesSha256":sha(&serde_json::to_vec(&changes).map_err(invalid)?),
                "changeCount":changes.len(),"changes":changes.iter().take(64).collect::<Vec<_>>(),
                "changesTruncated":changes.len()>64});
            engine.approval(&cell, &format!("delivery-{group_id}"), "fs_write", &approval, &cancel)
                .await.map_err(invalid)?;
            let _guard = delivery_guard(&engine, Some(&cancel)).await?;
            // 取消可能在审批/写租约等待期间落盘；最终准入以最新持久事实为准。
            // 已有交付日志仍由 deliver 回读；后续每步检查专用组取消 token。
            if bundle.cancel.is_cancelled() || engine.execution_group_cancel_requested(&thread_id, &group_id, automatic).await? {
                if let Some(journal) = load(&bundle.journal).await.map_err(invalid)? {
                    return inspect(&bundle, journal, &thread_id, &group_id).await.map_err(invalid);
                }
                return Ok(json!({"status":"cancelled","applied":false,"groupId":group_id,"head":expected_head}));
            }
            if cancel.is_cancelled() { return Err(crate::Error::Closed); }
            if cell.state.lock().await.active.as_ref().is_none_or(|active| active.id != turn_id) {
                return Err(crate::Error::Conflict);
            }
            // 审批或写锁等待期间 Goal 可能已停止；在启动整组副作用前重新确认。
            if let Some(error) = engine.goal_tool_guard(&cell, "fs_write").await.map_err(invalid)? {
                return Err(invalid(error));
            }
            let root_scope: rt::ScopeInfo = runtime.client.call("scope.get", json!({"scopeId":runtime.client.info().root_scope_id}))
                .await.map_err(invalid)?;
            if root_scope.active_processes != 0 {
                return Err(invalid("workspace is busy: settle active Runtime processes before artifact delivery"));
            }
            deliver(runtime.client.as_ref(), &runtime.client.info().root_scope_id, &bundle, &thread_id, &group_id, Some(&cancel), &ServiceVerifier { service, group: &group_id })
                .await.map_err(invalid)
        }).await
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        os::unix::fs::PermissionsExt,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    struct NeverVerify;
    #[async_trait]
    impl Verifier for NeverVerify {
        async fn verify(
            &self,
            _: Tree,
            _: tokio_util::sync::CancellationToken,
        ) -> Result<Option<super::super::Check>> {
            panic!(
                "unchanged accepted candidates and automatic candidates must not invoke a verifier"
            );
        }
    }
    struct FilesFixture {
        workspace: PathBuf,
        staged: Mutex<BTreeMap<String, Vec<u8>>>,
        calls: AtomicUsize,
        fail_at: Option<usize>,
        lose_commit_receipt: bool,
        cancel_after_commit: Option<tokio_util::sync::CancellationToken>,
    }
    #[async_trait]
    impl Files for FilesFixture {
        fn operation_id(&self) -> String {
            uuid::Uuid::new_v4().to_string()
        }
        async fn execute(&self, request: rt::FileRequest) -> rt::Result<Value> {
            let count = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail_at == Some(count) {
                return Err(rt::Error::new(rt::ErrorCode::Unavailable, "lost receipt"));
            }
            let path = self.workspace.join(
                request
                    .command
                    .path()
                    .strip_prefix("workspace://repo/")
                    .unwrap(),
            );
            match request.command {
                rt::FileCommand::StageFileChunk {
                    upload_id,
                    offset,
                    data_base64,
                    ..
                } => {
                    self.staged
                        .lock()
                        .unwrap()
                        .entry(upload_id.clone())
                        .or_default()
                        .extend(STANDARD.decode(&data_base64).unwrap());
                    return Ok(
                        json!({"uploadId":upload_id,"nextOffset":offset + STANDARD.decode(data_base64).unwrap().len() as u64}),
                    );
                }
                rt::FileCommand::CommitFile {
                    upload_id,
                    executable,
                    sha256,
                    ..
                } => {
                    let bytes = self.staged.lock().unwrap().remove(&upload_id).unwrap();
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(&path, bytes).unwrap();
                    std::fs::set_permissions(
                        path,
                        std::fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
                    )
                    .unwrap();
                    if let Some(cancel) = &self.cancel_after_commit {
                        cancel.cancel();
                    }
                    if self.lose_commit_receipt {
                        return Err(rt::Error::new(
                            rt::ErrorCode::Unavailable,
                            "commit completed but receipt was lost",
                        ));
                    }
                    return Ok(json!({"sha256":sha256,"executable":executable}));
                }
                rt::FileCommand::RemoveFile { .. } => {
                    std::fs::remove_file(path).unwrap();
                }
                _ => unreachable!(),
            }
            Ok(json!({"removed":true}))
        }
    }
    fn fixture() -> (tempfile::TempDir, Bundle, FilesFixture) {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("old"), b"old").unwrap();
        std::fs::write(workspace.join("unchanged"), b"baseline").unwrap();
        let base = tree::snapshot(&workspace).unwrap();
        let mut candidate = base.clone();
        candidate.remove("old");
        candidate.insert(
            "new/script".into(),
            tree::File {
                bytes: vec![42; 150_000],
                executable: true,
            },
        );
        let bundle = Bundle {
            owner: "parent/turn".into(),
            workspace: workspace.clone(),
            journal: root.path().join("delivery.json"),
            base,
            candidate,
            verified: true,
            strict: true,
            cancel: tokio_util::sync::CancellationToken::new(),
        };
        let files = FilesFixture {
            workspace,
            staged: Mutex::new(BTreeMap::new()),
            calls: AtomicUsize::new(0),
            fail_at: None,
            lose_commit_receipt: false,
            cancel_after_commit: None,
        };
        (root, bundle, files)
    }
    #[tokio::test]
    async fn delivery_rejects_a_stale_changed_file_before_any_side_effect() {
        let (_root, bundle, files) = fixture();
        std::fs::write(bundle.workspace.join("old"), b"user change").unwrap();
        let result = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "conflict");
        assert_eq!(files.calls.load(Ordering::SeqCst), 0);
        assert!(bundle.workspace.join("old").exists());
    }

    #[tokio::test]
    async fn unrepresentable_paths_reject_the_entire_delivery_before_writing_earlier_files() {
        for path in ["zz-name#part", "zz-name?part", "zz-name%part"] {
            let (_root, mut bundle, files) = fixture();
            bundle.candidate.insert(
                "old".into(),
                tree::File {
                    bytes: b"earlier valid modification".to_vec(),
                    executable: false,
                },
            );
            bundle.candidate.insert(
                path.into(),
                tree::File {
                    bytes: b"late unsupported path".to_vec(),
                    executable: false,
                },
            );
            let result = deliver(
                &files,
                "scope",
                &bundle,
                "parent",
                "group",
                None,
                &NeverVerify,
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "conflict");
            assert_eq!(result["applied"], false);
            assert_eq!(result["steps"], 0);
            assert!(result["error"].as_str().unwrap().contains("Runtime v0"));
            assert_eq!(files.calls.load(Ordering::SeqCst), 0);
            assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.base);
            assert_eq!(std::fs::read(bundle.workspace.join("old")).unwrap(), b"old");
        }
    }

    #[tokio::test]
    async fn directory_replacement_is_rejected_before_any_source_operation() {
        for has_child in [false, true] {
            let (_root, mut bundle, files) = fixture();
            std::fs::create_dir(bundle.workspace.join("zz-target")).unwrap();
            if has_child {
                std::fs::write(bundle.workspace.join("zz-target/child"), b"child").unwrap();
            }
            bundle.base = tree::snapshot(&bundle.workspace).unwrap();
            bundle.candidate = bundle.base.clone();
            bundle.candidate.remove("zz-target/child");
            bundle.candidate.get_mut("old").unwrap().bytes = b"earlier valid modification".to_vec();
            for path in ["aa-earlier", "zz-target"] {
                bundle.candidate.insert(
                    path.into(),
                    tree::File {
                        bytes: b"replacement".to_vec(),
                        executable: false,
                    },
                );
            }
            let result = deliver(
                &files,
                "scope",
                &bundle,
                "parent",
                "group",
                None,
                &NeverVerify,
            )
            .await
            .unwrap();
            assert_eq!(result["status"], "conflict");
            assert_eq!(result["applied"], false);
            assert_eq!(result["steps"], 0);
            assert!(
                result["error"]
                    .as_str()
                    .unwrap()
                    .contains("cannot replace a directory")
            );
            assert_eq!(files.calls.load(Ordering::SeqCst), 0);
            assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.base);
            assert!(bundle.workspace.join("zz-target").is_dir());
            assert_eq!(std::fs::read(bundle.workspace.join("old")).unwrap(), b"old");
        }
    }

    #[tokio::test]
    async fn preflight_allows_file_to_directory_and_unchanged_special_names() {
        let (_root, mut bundle, files) = fixture();
        for path in ["untouched#", "untouched?", "untouched%"] {
            std::fs::write(bundle.workspace.join(path), b"unchanged").unwrap();
        }
        bundle.base = tree::snapshot(&bundle.workspace).unwrap();
        bundle.candidate = bundle.base.clone();
        bundle.candidate.remove("old");
        bundle.candidate.insert(
            "old/child".into(),
            tree::File {
                bytes: b"inside new directory".to_vec(),
                executable: false,
            },
        );
        let result = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "applied");
        assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.candidate);
    }

    #[tokio::test]
    async fn delivery_records_every_receipt_and_applies_large_files_delete_and_mode() {
        let (_root, bundle, files) = fixture();
        let result = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "applied");
        assert_eq!(result["verified"], true);
        assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.candidate);
        let count = files.calls.load(Ordering::SeqCst);
        let again = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(again["status"], "applied");
        assert_eq!(files.calls.load(Ordering::SeqCst), count);
        let journal = load(&bundle.journal).await.unwrap().unwrap();
        assert_eq!(journal.applied_paths.len(), 2);
        assert!(
            journal
                .steps
                .iter()
                .all(|step| step.state == "succeeded" && step.receipt.is_some())
        );
    }
    #[tokio::test]
    async fn unknown_delivery_never_replays_or_claims_applied_on_retry() {
        let (_root, bundle, mut files) = fixture();
        files.fail_at = Some(4);
        let first = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(first["status"], "unknown");
        let count = files.calls.load(Ordering::SeqCst);
        files.fail_at = None;
        let retry = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(retry["status"], "unknown");
        assert_eq!(files.calls.load(Ordering::SeqCst), count);
        assert_eq!(
            load(&bundle.journal)
                .await
                .unwrap()
                .unwrap()
                .steps
                .last()
                .unwrap()
                .state,
            "unknown"
        );
    }
    #[tokio::test]
    async fn interrupted_intent_is_inspection_only_and_does_not_invent_verification() {
        let (_root, mut bundle, files) = fixture();
        bundle.verified = false;
        let journal = Journal {
            version: 2,
            thread_id: "parent".into(),
            group_id: "group".into(),
            source_head: tree::digest(&bundle.candidate),
            head: tree::digest(&bundle.candidate),
            baseline: tree::digest(&bundle.base),
            verified: false,
            verification: None,
            status: "applying".into(),
            applied_paths: vec![],
            steps: vec![],
            error: None,
        };
        save(&bundle.journal, &journal).await.unwrap();
        let result = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "unknown");
        assert_eq!(result["verified"], false);
        assert_eq!(files.calls.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn matching_workspace_cannot_upgrade_a_lost_commit_receipt_to_applied() {
        let (_root, mut bundle, mut files) = fixture();
        bundle.candidate = bundle.base.clone();
        bundle.candidate.insert(
            "old".into(),
            tree::File {
                bytes: b"replacement".to_vec(),
                executable: false,
            },
        );
        files.lose_commit_receipt = true;
        let first = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(first["status"], "unknown");
        assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.candidate);
        let count = files.calls.load(Ordering::SeqCst);
        let retry = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(retry["workspaceMatches"], true);
        assert_eq!(retry["applied"], false);
        assert_eq!(files.calls.load(Ordering::SeqCst), count);
    }
    #[tokio::test]
    async fn cancellation_prevents_the_next_delivery_operation() {
        let (_root, bundle, files) = fixture();
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let result = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            Some(&cancel),
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "partial");
        assert_eq!(result["applied"], false);
        assert_eq!(files.calls.load(Ordering::SeqCst), 0);
        assert_eq!(tree::snapshot(&bundle.workspace).unwrap(), bundle.base);
    }

    #[tokio::test]
    async fn group_cancellation_settles_the_started_commit_without_replaying_or_removing_more_files()
     {
        for lose_receipt in [false, true] {
            let (_root, bundle, mut files) = fixture();
            files.cancel_after_commit = Some(bundle.cancel.clone());
            files.lose_commit_receipt = lose_receipt;
            let result = deliver(
                &files,
                "scope",
                &bundle,
                "parent",
                "group",
                None,
                &NeverVerify,
            )
            .await
            .unwrap();
            assert_eq!(
                result["status"],
                if lose_receipt { "unknown" } else { "partial" }
            );
            assert_eq!(
                result["lastOperation"]["state"],
                if lose_receipt { "unknown" } else { "succeeded" }
            );
            assert_eq!(result["appliedFiles"], if lose_receipt { 0 } else { 1 });
            assert_eq!(std::fs::read(bundle.workspace.join("old")).unwrap(), b"old");
            assert_eq!(
                std::fs::read(bundle.workspace.join("new/script")).unwrap(),
                vec![42; 150_000]
            );
            let calls = files.calls.load(Ordering::SeqCst);
            let repeated = deliver(
                &files,
                "scope",
                &bundle,
                "parent",
                "group",
                None,
                &NeverVerify,
            )
            .await
            .unwrap();
            assert_eq!(repeated["status"], result["status"]);
            assert_eq!(files.calls.load(Ordering::SeqCst), calls);
        }
    }

    #[tokio::test]
    async fn cancellation_after_complete_delivery_preserves_the_applied_receipt() {
        let (_root, bundle, files) = fixture();
        assert_eq!(
            deliver(
                &files,
                "scope",
                &bundle,
                "parent",
                "group",
                None,
                &NeverVerify
            )
            .await
            .unwrap()["status"],
            "applied"
        );
        bundle.cancel.cancel();
        let calls = files.calls.load(Ordering::SeqCst);
        let repeated = deliver(
            &files,
            "scope",
            &bundle,
            "parent",
            "group",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(repeated["status"], "applied");
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
    }
    struct ExpectedVerifier {
        expected: Tree,
        passed: bool,
        calls: AtomicUsize,
    }
    #[async_trait]
    impl Verifier for ExpectedVerifier {
        async fn verify(
            &self,
            candidate: Tree,
            _: tokio_util::sync::CancellationToken,
        ) -> Result<Option<super::super::Check>> {
            assert_eq!(candidate, self.expected);
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Some(super::super::Check {
                tree_hash: tree::digest(&candidate),
                passed: self.passed,
                output: "trusted combined-tree check".into(),
            }))
        }
    }
    fn independent_bundle(first: &Bundle) -> Bundle {
        let mut candidate = first.base.clone();
        candidate.get_mut("unchanged").unwrap().bytes = b"independent second change".to_vec();
        Bundle {
            owner: first.owner.clone(),
            workspace: first.workspace.clone(),
            journal: first.journal.with_file_name("second-delivery.json"),
            base: first.base.clone(),
            candidate,
            verified: first.verified,
            strict: first.strict,
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }
    #[tokio::test]
    async fn independent_automatic_candidates_compose_and_retry_without_replaying() {
        let (_root, mut first, files) = fixture();
        first.strict = false;
        first.verified = false;
        let second = independent_bundle(&first);
        let a = deliver(
            &files,
            "scope",
            &first,
            "parent",
            "first",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(a["status"], "applied");
        let b = deliver(
            &files,
            "scope",
            &second,
            "parent",
            "second",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(b["status"], "applied");
        assert_eq!(b["verified"], false);
        assert_ne!(b["head"], b["sourceHead"]);
        assert_eq!(b["sourceHead"], tree::digest(&second.candidate));
        let mut expected = first.candidate.clone();
        expected.insert("unchanged".into(), second.candidate["unchanged"].clone());
        assert_eq!(tree::snapshot(&first.workspace).unwrap(), expected);
        let journal = load(&second.journal).await.unwrap().unwrap();
        assert_eq!(journal.baseline, tree::digest(&first.candidate));
        assert_eq!(
            tree::load(second.journal.parent().unwrap(), &journal.head).unwrap(),
            expected
        );
        let calls = files.calls.load(Ordering::SeqCst);
        let retry = deliver(
            &files,
            "scope",
            &second,
            "parent",
            "second",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(retry["status"], "applied");
        assert_eq!(retry["workspaceMatches"], true);
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
        std::fs::write(first.workspace.join("later"), b"user change after delivery").unwrap();
        let later = deliver(
            &files,
            "scope",
            &second,
            "parent",
            "second",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(later["workspaceMatches"], false);
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
    }
    #[tokio::test]
    async fn strict_composition_verifies_the_frozen_combined_tree_before_delivery() {
        let (_root, first, files) = fixture();
        let second = independent_bundle(&first);
        deliver(
            &files,
            "scope",
            &first,
            "parent",
            "first",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        let mut expected = first.candidate.clone();
        expected.insert("unchanged".into(), second.candidate["unchanged"].clone());
        let verifier = ExpectedVerifier {
            expected: expected.clone(),
            passed: true,
            calls: AtomicUsize::new(0),
        };
        let result = deliver(
            &files, "scope", &second, "parent", "second", None, &verifier,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "applied");
        assert_eq!(result["verified"], true);
        assert_eq!(tree::snapshot(&first.workspace).unwrap(), expected);
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
        let journal = load(&second.journal).await.unwrap().unwrap();
        assert_eq!(journal.verification.unwrap().tree_hash, journal.head);
        deliver(
            &files,
            "scope",
            &second,
            "parent",
            "second",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn failed_strict_composition_acceptance_applies_nothing_and_is_not_retried() {
        let (_root, first, files) = fixture();
        let second = independent_bundle(&first);
        deliver(
            &files,
            "scope",
            &first,
            "parent",
            "first",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        let mut expected = first.candidate.clone();
        expected.insert("unchanged".into(), second.candidate["unchanged"].clone());
        let verifier = ExpectedVerifier {
            expected,
            passed: false,
            calls: AtomicUsize::new(0),
        };
        let calls = files.calls.load(Ordering::SeqCst);
        let result = deliver(
            &files, "scope", &second, "parent", "second", None, &verifier,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "conflict");
        assert_eq!(result["verified"], false);
        assert_eq!(result["applied"], false);
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
        assert_eq!(tree::snapshot(&first.workspace).unwrap(), first.candidate);
        let retry = deliver(
            &files,
            "scope",
            &second,
            "parent",
            "second",
            None,
            &NeverVerify,
        )
        .await
        .unwrap();
        assert_eq!(retry["status"], "conflict");
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
        assert_eq!(files.calls.load(Ordering::SeqCst), calls);
    }
}
