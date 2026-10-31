use super::*;
use areal_runtime_protocol as rt;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AdditionalPermissions {
    #[serde(default)]
    read_roots: Vec<String>,
    #[serde(default)]
    write_roots: Vec<String>,
    #[serde(default)]
    network: bool,
    justification: String,
}

pub(crate) fn additional_schema() -> Value {
    json!({"type":"object","properties":{
        "readRoots":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1,"maxLength":4096}},
        "writeRoots":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1,"maxLength":4096}},
        "network":{"type":"boolean"},"justification":{"type":"string","minLength":1,"maxLength":2048}},
        "required":["justification"],"additionalProperties":false})
}

fn invalid(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::InvalidArgument, error.to_string())
}
fn unknown(error: impl std::fmt::Display) -> rt::Error {
    rt::Error::new(rt::ErrorCode::Unavailable, error.to_string())
}

impl Engine {
    pub(crate) async fn permission_journal(
        &self,
        cell: &Cell,
        call_id: &str,
        change: impl FnOnce(&mut areal_protocol::ToolExecution),
    ) -> rt::Result<()> {
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let execution = candidate
            .turns
            .last_mut()
            .and_then(|turn| {
                turn.items.iter_mut().find_map(|item| match item {
                    Item::DynamicToolCall {
                        call_id: id,
                        execution,
                        ..
                    } if id == call_id => Some(execution),
                    _ => None,
                })
            })
            .ok_or_else(|| invalid("permission journal call missing"))?;
        change(execution);
        self.persist(&candidate).await.map_err(unknown)?;
        state.thread = candidate;
        Ok(())
    }

    async fn permission_scope(
        &self,
        cell: &Cell,
        call_id: Option<&str>,
        kind: &str,
        parent: String,
        permissions: rt::PermissionRequest,
        limits: rt::LimitRequest,
    ) -> rt::Result<String> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| unknown("Runtime unavailable"))?;
        let operation = runtime.client.operation_id();
        if let Some(call_id) = call_id {
            self.permission_journal(cell, call_id, |execution| execution.permission_scopes.push(
                json!({"kind":kind,"operationId":operation,"parentScopeId":parent,"permissions":permissions})
            )).await?;
        }
        let owner = {
            let state = cell.state.lock().await;
            format!("{}/{}", cell.id, state.active.as_ref().unwrap().id)
        };
        let result = runtime
            .client
            .create_scope(rt::CreateScope {
                operation_id: operation.clone(),
                parent_scope_id: parent,
                owner: rt::Owner {
                    task_id: owner,
                    plugin_instance_id: None,
                },
                permissions,
                limits,
            })
            .await;
        match result {
            Ok(scope) => {
                if kind == "authority" {
                    cell.state.lock().await.active.as_mut().unwrap().scope =
                        Some(scope.scope_id.clone());
                }
                if let Some(call_id) = call_id {
                    self.permission_journal(cell, call_id, |execution| {
                        if let Some(record) = execution
                            .permission_scopes
                            .iter_mut()
                            .find(|r| r["operationId"] == operation)
                        {
                            record["scopeId"] = json!(scope.scope_id);
                        }
                        if kind != "authority" {
                            execution.scope_id = scope.scope_id.clone();
                        }
                    })
                    .await?;
                }
                Ok(scope.scope_id)
            }
            Err(error) => {
                if matches!(
                    error.code,
                    rt::ErrorCode::Unavailable
                        | rt::ErrorCode::CleanupFailed
                        | rt::ErrorCode::StaleHandle
                ) {
                    cell.state.lock().await.poisoned = true;
                }
                Err(error)
            }
        }
    }

    pub(crate) async fn ensure_turn_scope(
        &self,
        cell: &Cell,
        call_id: Option<&str>,
    ) -> rt::Result<String> {
        let _guard = cell.resource_gate.lock().await;
        let (base, authority, elapsed) = {
            let state = cell.state.lock().await;
            let active = state.active.as_ref().unwrap();
            (
                active.base_scope.clone(),
                active.scope.clone(),
                active.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            )
        };
        if let Some(base) = base {
            if let Some(call_id) = call_id {
                self.permission_journal(cell, call_id, |execution| {
                    execution.scope_id = base.clone()
                })
                .await?;
            }
            return Ok(base);
        }
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| unknown("Runtime unavailable"))?;
        let authority = match authority {
            Some(scope) => scope,
            None => {
                let parent = self.runtime_task_parent(cell).await?;
                let info: rt::ScopeInfo = runtime
                    .client
                    .call("scope.get", json!({"scopeId":parent}))
                    .await?;
                let mut permissions = rt::PermissionRequest::default();
                let hard_restricted = {
                    let state = cell.state.lock().await;
                    state.thread.is_read_only_side()
                        || state.thread.parent_thread_id.is_some()
                        || cell.research
                        || state
                            .thread
                            .turns
                            .last()
                            .and_then(|t| t.configuration.as_ref())
                            .is_some_and(|c| c.read_only)
                };
                if hard_restricted {
                    permissions = self.active_permissions(cell).await.map_err(invalid)?;
                }
                self.permission_scope(
                    cell,
                    call_id,
                    "authority",
                    parent,
                    permissions,
                    rt::LimitRequest {
                        wall_time_ms: Some(info.limits.wall_time_ms.saturating_sub(elapsed).max(1)),
                        ..Default::default()
                    },
                )
                .await?
            }
        };
        let permissions = self.active_permissions(cell).await.map_err(invalid)?;
        let scope = self
            .permission_scope(
                cell,
                call_id,
                "base",
                authority,
                permissions,
                Default::default(),
            )
            .await?;
        cell.state.lock().await.active.as_mut().unwrap().base_scope = Some(scope.clone());
        Ok(scope)
    }

    pub(crate) async fn requested_permissions(
        &self,
        cell: &Cell,
        tool: &str,
        arguments: &mut Value,
    ) -> rt::Result<Option<rt::PermissionRequest>> {
        let Some(value) = arguments.get("permissionRequest") else {
            return Ok(None);
        };
        if tool != "run_command" {
            return Err(invalid(
                "permissionRequest is only supported by run_command",
            ));
        }
        let mut requested: AdditionalPermissions =
            serde_json::from_value(value.clone()).map_err(invalid)?;
        if requested.read_roots.len() > 16
            || requested.write_roots.len() > 16
            || requested.justification.trim().is_empty()
            || requested.justification.len() > 2048
        {
            return Err(invalid("permissionRequest exceeds bounds"));
        }
        let (authority, preset) = {
            let state = cell.state.lock().await;
            let configuration = state
                .thread
                .turns
                .last()
                .and_then(|turn| turn.configuration.as_ref());
            if state.thread.is_read_only_side()
                || cell.research
                || configuration.is_some_and(|c| c.read_only)
            {
                return Err(rt::Error::new(
                    rt::ErrorCode::PermissionDenied,
                    "hard restrictions forbid additional permissions",
                ));
            }
            (
                state
                    .active
                    .as_ref()
                    .and_then(|active| active.scope.clone()),
                configuration.and_then(|c| c.options.permission_preset),
            )
        };
        if preset.is_none() {
            return Err(invalid(
                "permissionRequest requires an explicit permission preset",
            ));
        }
        let authority = authority.ok_or_else(|| unknown("Turn authority unavailable"))?;
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| unknown("Runtime unavailable"))?;
        for root in requested
            .read_roots
            .iter_mut()
            .chain(requested.write_roots.iter_mut())
        {
            if root.is_empty() || root.len() > 4096 || root.contains('\0') {
                return Err(invalid("invalid requested root"));
            }
            *root = crate::tools::resource_uri(root, runtime).map_err(invalid)?;
            if root == "workspace://host" {
                return Err(invalid("a permission request must name a bounded root"));
            }
        }
        requested
            .read_roots
            .extend(requested.write_roots.iter().cloned());
        requested.read_roots.sort();
        requested.read_roots.dedup();
        requested.write_roots.sort();
        requested.write_roots.dedup();
        let mut permissions = self.active_permissions(cell).await.map_err(invalid)?;
        if let Some(reads) = permissions.read_roots.as_mut() {
            reads.extend(requested.read_roots.iter().cloned());
            reads.sort();
            reads.dedup();
        }
        if let Some(writes) = permissions.write_roots.as_mut() {
            writes.extend(requested.write_roots.iter().cloned());
            writes.sort();
            writes.dedup();
        }
        if requested.network {
            let parent: rt::ScopeInfo = runtime
                .client
                .call("scope.get", json!({"scopeId":authority}))
                .await?;
            if parent.network == rt::NetworkRequest::Deny {
                return Err(rt::Error::new(
                    rt::ErrorCode::PermissionDenied,
                    "requested network exceeds the deployment or parent ceiling",
                ));
            }
            permissions.network = rt::NetworkRequest::Inherit;
        }
        let check: rt::ScopeCheck = runtime
            .client
            .call(
                "scope.check",
                json!({"parentScopeId":authority,"permissions":permissions}),
            )
            .await?;
        if !check.available {
            return Err(rt::Error::new(
                rt::ErrorCode::Unsupported,
                "requested restricted scope is unavailable",
            ));
        }
        arguments["permissionRequest"] = serde_json::to_value(requested).map_err(invalid)?;
        Ok(Some(permissions))
    }

    pub(crate) async fn navigation_scope(
        &self,
        cell: &Cell,
        call_id: &str,
        parent: &str,
    ) -> rt::Result<String> {
        let runtime = self
            .runtime
            .as_ref()
            .ok_or_else(|| unknown("Runtime unavailable"))?;
        if runtime.client.info().capabilities["restrictedScopeIsolation"] != true {
            // 未提供受限 scope 的部署保留原执行契约，不把逻辑标签当成 OS 隔离。
            // 一旦已尝试创建受限 scope，失败必须原样返回，不能回退到更宽权限。
            self.permission_journal(cell, call_id, |execution| {
                execution.permission_scopes.push(json!({
                    "kind":"navigationInherited","scopeId":parent,
                    "reason":"restrictedScopeIsolationUnavailable"
                }));
            })
            .await?;
            return Ok(parent.into());
        }
        // 只有可信原生导航入口使用这个收窄作用域；同名外部工具不能继承此分类。
        // 按父作用域复用，避免每次读取消耗一个 Runtime scope 名额。
        let _guard = cell.resource_gate.lock().await;
        let existing = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .unwrap()
            .navigation_scopes
            .get(parent)
            .cloned();
        if let Some(scope) = existing {
            self.permission_journal(cell, call_id, |execution| {
                execution.scope_id = scope.clone();
                execution.permission_scopes.push(json!({
                    "kind":"navigationReadOnly","parentScopeId":parent,"scopeId":scope,"reused":true
                }));
            })
            .await?;
            return Ok(scope);
        }
        let scope = self
            .permission_scope(
                cell,
                Some(call_id),
                "navigationReadOnly",
                parent.into(),
                rt::PermissionRequest {
                    read_roots: None,
                    write_roots: Some(Vec::new()),
                    network: rt::NetworkRequest::Deny,
                },
                rt::LimitRequest::default(),
            )
            .await?;
        cell.state
            .lock()
            .await
            .active
            .as_mut()
            .unwrap()
            .navigation_scopes
            .insert(parent.into(), scope.clone());
        // 子作用域继承原读取边界和累计预算，由原 Turn 的父作用域统一取消、结算。
        Ok(scope)
    }

    pub(crate) async fn approved_operation_scope(
        &self,
        cell: &Cell,
        call_id: &str,
        permissions: rt::PermissionRequest,
    ) -> rt::Result<String> {
        let authority = cell
            .state
            .lock()
            .await
            .active
            .as_ref()
            .and_then(|active| active.scope.clone())
            .ok_or_else(|| unknown("Turn authority unavailable"))?;
        self.permission_scope(
            cell,
            Some(call_id),
            "operation",
            authority,
            permissions,
            Default::default(),
        )
        .await
    }
}
