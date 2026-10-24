use super::*;

fn close_reply(mut result: Value) -> Value {
    result.as_object_mut().unwrap().remove("cleanupSettled");
    result
}

fn canonical_text(item: &Item) -> Option<String> {
    match item {
        Item::UserMessage { content, .. } if content.len() == 1 => match &content[0] {
            Input::Text { text, .. } => Some(text.clone()),
            _ => None,
        },
        Item::AgentMessage { text, .. } => Some(text.clone()),
        Item::DynamicToolCall {
            success: Some(true),
            content_items: Some(parts),
            ..
        } if parts.len() == 1 => parts[0]["text"].as_str().map(str::to_owned),
        _ => None,
    }
}

fn resolve_selection(
    selection: &SideSelection,
    prefix: &[Turn],
) -> Result<areal_protocol::SideReference> {
    match selection {
        SideSelection::ItemRange {
            turn_id,
            item_id,
            start_utf8,
            end_utf8,
            text_sha256,
        } => {
            let item = prefix
                .iter()
                .find(|turn| &turn.id == turn_id)
                .and_then(|turn| turn.items.iter().find(|item| item.id() == item_id))
                .ok_or_else(|| invalid("STALE_SELECTION"))?;
            let text = canonical_text(item).ok_or_else(|| invalid("STALE_SELECTION"))?;
            let selected = text
                .get(*start_utf8..*end_utf8)
                .filter(|part| !part.is_empty())
                .ok_or_else(|| invalid("STALE_SELECTION"))?;
            if selected.len() > 16 * 1024 {
                return Err(invalid("SELECTION_TOO_LARGE"));
            }
            let actual = format!("{:x}", Sha256::digest(selected.as_bytes()));
            if !actual.eq_ignore_ascii_case(text_sha256) {
                return Err(invalid("STALE_SELECTION"));
            }
            Ok(areal_protocol::SideReference {
                selection: selection.clone(),
                text: selected.into(),
                verified: true,
            })
        }
        SideSelection::UserQuote { text, .. } if text.len() > 16 * 1024 => {
            Err(invalid("SELECTION_TOO_LARGE"))
        }
        SideSelection::UserQuote { text, .. } if !text.trim().is_empty() => {
            Ok(areal_protocol::SideReference {
                selection: selection.clone(),
                text: text.clone(),
                verified: false,
            })
        }
        _ => Err(invalid("invalid userQuote")),
    }
}

impl Engine {
    pub(crate) async fn reserve_side_creation(
        &self,
        source_id: &str,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        'validate: loop {
            let gate = self.thread_creation.lock().await;
            let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
            let mut deployment = 0;
            let mut source = 0;
            for cell in cells {
                let state = match cell.state.try_lock() {
                    Ok(state) => state,
                    Err(_) => {
                        // 既有 worker 持 parent.state 调用创建；不能反向持创建准入等待状态锁。
                        drop(gate);
                        drop(cell.state.lock().await);
                        continue 'validate;
                    }
                };
                if state.active.is_some()
                    && state.thread.is_read_only_side()
                    && let Some(areal_protocol::Conversation::Side { origin, .. }) =
                        &state.thread.conversation
                {
                    deployment += 1;
                    if origin.source_thread_id == source_id {
                        source += 1;
                    }
                }
            }
            if source >= self.limits.max_side_turns_per_source {
                return Err(Error::Exhausted("SIDE_SOURCE_CAPACITY_REACHED".into()));
            }
            if deployment >= self.limits.max_side_turns_per_deployment {
                return Err(Error::Exhausted("SIDE_DEPLOYMENT_CAPACITY_REACHED".into()));
            }
            return Ok(gate);
        }
    }
    pub(crate) async fn check_side_capacity(
        &self,
        source_id: &str,
        exclude_thread_id: Option<&str>,
    ) -> Result<()> {
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        let mut deployment = 0;
        let mut source = 0;
        for cell in cells {
            if exclude_thread_id == Some(cell.id.as_str()) {
                continue;
            }
            let state = cell.state.lock().await;
            if state.active.is_none() || !state.thread.is_read_only_side() {
                continue;
            }
            if let Some(areal_protocol::Conversation::Side { origin, .. }) =
                &state.thread.conversation
            {
                deployment += 1;
                if origin.source_thread_id == source_id {
                    source += 1;
                }
            }
        }
        if source >= self.limits.max_side_turns_per_source {
            return Err(Error::Exhausted("SIDE_SOURCE_CAPACITY_REACHED".into()));
        }
        if deployment >= self.limits.max_side_turns_per_deployment {
            return Err(Error::Exhausted("SIDE_DEPLOYMENT_CAPACITY_REACHED".into()));
        }
        Ok(())
    }
    pub async fn side_context_read(
        &self,
        thread_id: &str,
        evidence_ref: Option<String>,
        cursor: Option<String>,
        max_bytes: Option<usize>,
    ) -> Result<Value> {
        if evidence_ref.is_some() && cursor.is_some() {
            return Err(invalid("evidenceRef and cursor are mutually exclusive"));
        }
        let max_bytes = max_bytes.unwrap_or(8192);
        if !(64..=16384).contains(&max_bytes) {
            return Err(invalid("maxBytes must be 64..16384"));
        }
        let thread = self.read(thread_id, false).await?;
        let Some(areal_protocol::Conversation::Side {
            reference_snapshot, ..
        }) = thread.conversation
        else {
            return Err(invalid("SIDE_POLICY_VIOLATION"));
        };
        let snapshot = reference_snapshot.snapshot_id;
        let decode = |value: &str, with_offset: bool| -> Result<(usize, usize)> {
            let (prefix, tail) = value
                .rsplit_once(':')
                .ok_or_else(|| invalid("invalid evidence cursor"))?;
            let (id, index, offset) = if with_offset {
                let (id, index) = prefix
                    .rsplit_once(':')
                    .ok_or_else(|| invalid("invalid evidence cursor"))?;
                (id, index, tail.parse::<usize>().map_err(invalid)?)
            } else {
                (prefix, tail, 0)
            };
            if id != snapshot {
                return Err(invalid("invalid evidence cursor"));
            }
            Ok((index.parse().map_err(invalid)?, offset))
        };
        let (index, offset) = if let Some(value) = &evidence_ref {
            decode(value, false)?
        } else if let Some(value) = &cursor {
            decode(value, true)?
        } else {
            (0, 0)
        };
        self.store.fork_snapshot_page(snapshot.clone(), move |turns, source_ids| {
        let item_count = turns.iter().map(|turn| turn.items.len()).sum::<usize>();
        let mut entries = turns.into_iter().zip(source_ids).flat_map(|(turn, source)| turn.items.into_iter().map(move |item| {
            (source.clone(), turn.id.clone(), turn.status.clone(), item)
        }));
        if index > item_count || index == item_count && offset != 0 {
            return Err(invalid("invalid evidence cursor"));
        }
        if index == item_count {
            let page =
                json!({"snapshotId":snapshot,"evidence":[],"nextCursor":null,"complete":true});
            if serde_json::to_vec(&page).map_err(invalid)?.len() > max_bytes {
                return Err(invalid("EVIDENCE_BUDGET_TOO_SMALL"));
            }
            return Ok(page);
        }
        let (source, turn_id, status, item) = entries.nth(index).ok_or_else(|| invalid("invalid evidence cursor"))?;
        let entry = json!({"sourceThreadId":source,"sourceTurnId":turn_id,"sourceItemId":item.id(),"sourceTurnStatus":status,"item":item});
        let content = entry["item"].to_string();
        if offset > content.len() || !content.is_char_boundary(offset) {
            return Err(invalid("invalid evidence cursor"));
        }
        let rest = &content[offset..];
        let page_for = |part: &str| {
            let next_offset = offset + part.len();
            let next_cursor = if next_offset < content.len() {
                Some(format!("{}:{}:{}", snapshot, index, next_offset))
            } else if index + 1 < item_count {
                Some(format!("{}:{}:0", snapshot, index + 1))
            } else {
                None
            };
            json!({"snapshotId":snapshot,"evidence":[{"evidenceRef":format!("{}:{}",snapshot,index),
                "sourceTurnId":entry["sourceTurnId"],"sourceItemId":entry["sourceItemId"],
                "sourceTurnStatus":entry["sourceTurnStatus"],"text":part,
                "range":{"startUtf8":offset,"endUtf8":next_offset,"totalBytes":content.len()}}],
                "nextCursor":next_cursor,"complete":next_cursor.is_none()})
        };
        // 页预算覆盖整个序列化响应；转义和游标字节都计入，避免高转义内容放大输出。
        let mut low = 0usize;
        let mut high = rest.len().min(max_bytes);
        let mut best = None;
        while low <= high {
            let mid = low + (high - low) / 2;
            let mut end = mid;
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            let page = page_for(&rest[..end]);
            if serde_json::to_vec(&page).map_err(invalid)?.len() <= max_bytes {
                best = Some(page);
                low = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                high = mid - 1;
            }
        }
        let page = best.ok_or_else(|| invalid("EVIDENCE_BUDGET_TOO_SMALL"))?;
        if !rest.is_empty()
            && page["evidence"][0]["range"]["endUtf8"].as_u64() == Some(offset as u64)
        {
            return Err(invalid("EVIDENCE_BUDGET_TOO_SMALL"));
        }
        Ok(page)
        }).await
    }
    /// 首问与只读身份在同一持久记录中提交；提交之前不会激活模型。
    pub async fn side_start(
        self: &Arc<Self>,
        identity: String,
        request: SideStart,
    ) -> Result<(Thread, Turn)> {
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let _admission_gate = engine.desktop.lifecycle.gate.lock().await;
            if request.reset_model && request.model.is_some() {
                return Err(invalid("resetModel and model cannot be combined"));
            }
            let hash = digest(&request)?;
            let method = "areal/side/start";
            if !valid_id(&request.request_id) {
                return Err(invalid("invalid requestId"));
            }
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop
                    && let Some(found) = data.receipts.iter().find(|r| {
                        r.identity == identity
                            && r.request_id == request.request_id
                            && r.method == method
                    })
                {
                    if found.digest != hash {
                        return Err(Error::Conflict);
                    }
                    // 归档和压缩会释放驻留 Turn，回执必须从完整持久历史恢复首轮。
                    let saved = engine
                        .store
                        .read_thread(&state.thread.id)
                        .await
                        .map_err(|error| Error::Storage(error.to_string()))?;
                    let turn = match found.result.get("turnId").and_then(Value::as_str) {
                        Some(id) => saved.turns.iter().find(|turn| turn.id == id),
                        None => saved.turns.first(),
                    }
                    .cloned()
                    .ok_or_else(|| Error::Storage("Side first Turn missing".into()))?;
                    return Ok((state.thread.clone(), turn));
                }
            }
            if !matches!(request.workspace_access.as_str(), "none" | "readOnly") {
                return Err(invalid("invalid workspaceAccess"));
            }
            if request.workspace_access == "readOnly" && !engine.side_workspace_read_available() {
                return Err(invalid("WORKSPACE_READ_UNAVAILABLE"));
            }
            if request.input.len() != 1 || !matches!(&request.input[0], Input::Text { .. }) {
                return Err(invalid("Side first question must be one text input"));
            }
            let source_cell = engine.raw_cell(&request.source_thread_id).await?;
            let source_state = source_cell.state.lock().await;
            if source_state.thread.parent_thread_id.is_some()
                || source_state.thread.is_side()
                || source_state
                    .thread
                    .desktop
                    .as_ref()
                    .is_some_and(|d| d.workflow_run.is_some() || d.archived)
            {
                return Err(invalid("SOURCE_KIND_UNSUPPORTED"));
            }
            let cwd = source_state.thread.cwd.clone();
            // 锚点只固定模型与证据；当前来源策略限制新旁路的读取授权。
            let source_allowlist = desktop(&source_state.thread).configuration.tool_allowlist;
            drop(source_state);
            let source = engine
                .store
                .read_thread(&request.source_thread_id)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            let (mut logical, mut source_ids) = match &source.conversation {
                Some(areal_protocol::Conversation::Fork { history_seed, .. }) => engine
                    .store
                    .read_fork_snapshot_with_sources(&history_seed.snapshot_id)
                    .map_err(|e| Error::Storage(e.to_string()))?,
                _ => (Vec::new(), Vec::new()),
            };
            source_ids.extend(std::iter::repeat_n(source.id.clone(), source.turns.len()));
            logical.extend(source.turns.iter().cloned());
            let anchor = request.anchor.as_ref();
            let end = match anchor {
                None => logical.len(),
                Some(SideAnchor { kind, .. }) if kind == "latestCommitted" => logical.len(),
                Some(SideAnchor {
                    kind,
                    turn_id: Some(id),
                    boundary: Some(boundary),
                }) if kind == "turn" => {
                    let index = logical
                        .iter()
                        .position(|t| &t.id == id)
                        .ok_or_else(|| invalid("ANCHOR_NOT_FOUND"))?;
                    match boundary.as_str() {
                        "before" => index,
                        "after" if logical[index].status != TurnStatus::InProgress => index + 1,
                        "after" => return Err(invalid("TURN_NOT_TERMINAL")),
                        _ => return Err(invalid("invalid Side boundary")),
                    }
                }
                _ => return Err(invalid("invalid Side anchor")),
            };
            let prefix = &logical[..end];
            let selection = request
                .selection
                .as_ref()
                .map(|value| resolve_selection(value, prefix))
                .transpose()?;
            let item_count: usize = prefix.iter().map(|turn| turn.items.len()).sum();
            let preview = crate::history::side_context_text(
                &"0".repeat(64),
                item_count,
                selection.as_ref(),
                &[],
            );
            if serde_json::to_vec(&preview).map_err(invalid)?.len() > 32 * 1024 {
                return Err(invalid("SELECTION_TOO_LARGE"));
            }
            let config = prefix
                .iter()
                .rev()
                .find_map(|t| t.configuration.clone())
                .unwrap_or_default();
            if config
                .profile
                .as_ref()
                .is_some_and(|p| p.workflow.is_some())
            {
                return Err(invalid("PROFILE_NOT_SUPPORTED"));
            }
            let mut config = engine.resolve_config(
                None,
                if request.reset_model {
                    None
                } else {
                    request.model.or(config.model)
                },
                request.parameters.unwrap_or(config.parameters),
                config.revision,
            )?;
            config.profile = None;
            config.read_only = true;
            engine.project_permissions(&mut config);
            config.tool_allowlist = Some(
                std::iter::once("side_context_read".to_owned())
                    .chain(
                        engine
                            .extensions
                            .gen_ui
                            .then(|| "gen_ui_publish".to_owned()),
                    )
                    .chain(
                        ["fs_read", "fs_list", "fs_stat", "search_files"]
                            .into_iter()
                            .filter(|name| {
                                request.workspace_access == "readOnly"
                                    && source_allowlist.as_ref().is_none_or(|allowed| {
                                        allowed.iter().any(|entry| entry == name)
                                    })
                            })
                            .map(str::to_owned),
                    )
                    .collect(),
            );
            config.instructions.clear();
            config.options.system_prompt = None;
            config.options.append_instructions.clear();
            config.options.max_model_rounds = Some(
                config
                    .options
                    .max_model_rounds
                    .unwrap_or(engine.limits.max_side_model_rounds)
                    .min(engine.limits.max_side_model_rounds),
            );
            let model = engine
                .configured_model(&config)
                .map_err(|_| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
            if !model
                .capabilities()
                .supports_input(areal_protocol::Modality::Text)
            {
                return Err(invalid("MODEL_CONTEXT_INCOMPATIBLE"));
            }
            let limit = if engine.limits.max_history_bytes == 0 {
                64 * 1024 * 1024
            } else {
                engine.limits.max_history_bytes.min(64 * 1024 * 1024)
            };
            let (snapshot_id, logical_bytes) = engine
                .store
                .write_fork_snapshot(prefix.to_vec(), source_ids[..end].to_vec(), limit)
                .await
                .map_err(|e| Error::Storage(e.to_string()))?;
            let thread_id = id();
            let mut data = DesktopState {
                configuration: config,
                ..Default::default()
            };
            remember(
                &mut data,
                &identity,
                &request.request_id,
                method,
                hash.clone(),
                json!({"threadId":thread_id}),
            );
            let origin_turn = match anchor {
                Some(SideAnchor {
                    kind,
                    turn_id: Some(id),
                    ..
                }) if kind == "turn" => id.clone(),
                _ => prefix.last().map(|t| t.id.clone()).unwrap_or_default(),
            };
            let boundary = match anchor {
                Some(SideAnchor {
                    kind,
                    boundary: Some(boundary),
                    ..
                }) if kind == "turn" => boundary.as_str(),
                _ => "latestCommitted",
            };
            let base = Thread {
                conversation: Some(areal_protocol::Conversation::Side {
                    version: 1,
                    origin: areal_protocol::ConversationOrigin {
                        source_thread_id: request.source_thread_id,
                        source_turn_id: origin_turn,
                        boundary: boundary.into(),
                        snapshot_id: snapshot_id.clone(),
                    },
                    reference_snapshot: areal_protocol::HistorySeed {
                        snapshot_id,
                        turn_count: end,
                        item_count: prefix.iter().map(|t| t.items.len()).sum(),
                        logical_bytes,
                    },
                    policy: areal_protocol::SidePolicy::ReadOnlyV1 {
                        workspace_access: if request.workspace_access == "readOnly" {
                            areal_protocol::SideWorkspaceAccess::ReadOnly
                        } else {
                            areal_protocol::SideWorkspaceAccess::None
                        },
                    },
                    selection,
                }),
                goals: Default::default(),
                goal_owner: None,
                desktop: Some(data),
                id: thread_id.clone(),
                session_id: thread_id.clone(),
                parent_thread_id: None,
                preview: String::new(),
                name: None,
                name_attempt_turn_id: None,
                model_provider: engine.model_provider(),
                created_at: now(),
                updated_at: now(),
                status: ThreadStatus::Idle,
                cwd,
                cli_version: env!("CARGO_PKG_VERSION").into(),
                source: "appServer".into(),
                ephemeral: false,
                turns: Vec::new(),
                history_archive: None,
                context_checkpoint: None,
                dynamic_tools: Vec::new(),
                toolset_revision: 0,
            };
            let (mut thread, turn) = engine.prepare_turn(&base, request.input)?;
            if let Some(data) = thread.desktop.as_mut()
                && let Some(record) = data.receipts.iter_mut().find(|record| {
                    record.identity == identity
                        && record.request_id == request.request_id
                        && record.method == method
                })
            {
                record.result = json!({"threadId":thread_id,"turnId":turn.id});
            }
            engine.check_side_capacity(&source.id, None).await?;
            let admission = engine.reserve_active_turn()?;
            let cell = Cell::new(
                thread.clone(),
                0,
                crate::tools::Bindings {
                    registry: engine
                        .registry
                        .clone()
                        .side_only(request.workspace_access == "readOnly"),
                    host: None,
                },
                None,
            );
            let _creation = engine.reserve_side_creation(&source.id).await?;
            if engine.threads.read().await.len() >= engine.limits.max_threads {
                return Err(Error::Exhausted("thread capacity reached".into()));
            }
            if let Err(error) = engine.persist(&thread).await {
                if let Ok(saved) = engine.store.read_thread(&thread_id).await
                    && saved.desktop.as_ref().is_some_and(|d| {
                        receipt(d, &identity, &request.request_id, method, &hash)
                            .ok()
                            .flatten()
                            .is_some()
                    })
                {
                    cell.state.lock().await.poisoned = true;
                    engine.threads.write().await.insert(thread_id, cell);
                }
                return Err(error);
            }
            let mut state = cell.state.lock().await;
            engine.activate(
                &cell,
                &mut state,
                &turn,
                engine.shutdown.child_token(),
                admission,
            );
            drop(state);
            engine.threads.write().await.insert(thread_id, cell);
            Ok((thread, turn))
        })
        .await
    }
}

impl Engine {
    pub async fn side_create(
        self: &Arc<Self>,
        identity: String,
        request: SideCreate,
        host: Option<Arc<dyn crate::tools::DynamicToolHost>>,
    ) -> Result<(Thread, Option<Turn>)> {
        self.refresh_plugins().await?;
        self.mutate(move |engine| async move {
            let _serial = engine.desktop.creation.lock().await;
            let _admission = engine.desktop.lifecycle.gate.lock().await;
            let method = "areal/side/create";
            let hash = digest(&request)?;
            if !valid_id(&request.request_id) {
                return Err(invalid("invalid requestId"));
            }
            let cells: Vec<_> = engine.threads.read().await.values().cloned().collect();
            for cell in cells {
                let state = cell.state.lock().await;
                if let Some(data) = &state.thread.desktop
                    && let Some(found) = data.receipts.iter().find(|r| {
                        r.identity == identity
                            && r.request_id == request.request_id
                            && r.method == method
                    })
                {
                    if found.digest != hash {
                        return Err(Error::Conflict);
                    }
                    let turn = if let Some(id) = found.result.get("turnId").and_then(Value::as_str)
                    {
                        Some(
                            engine
                                .store
                                .read_thread(&state.thread.id)
                                .await
                                .map_err(invalid)?
                                .turns
                                .into_iter()
                                .find(|turn| turn.id == id)
                                .ok_or_else(|| Error::Storage("Side first turn missing".into()))?,
                        )
                    } else {
                        None
                    };
                    return Ok((state.thread.clone(), turn));
                }
            }
            if !engine.accepting_work() {
                return Err(Error::Closed);
            }
            if host
                .as_ref()
                .is_some_and(|host| host.is_closed() || host.identity() != identity)
            {
                return Err(Error::Conflict);
            }
            let source_cell = engine.cell(&request.source_thread_id).await?;
            let source_state = source_cell.state.lock().await;
            if source_state.thread.is_side()
                || source_state.thread.parent_thread_id.is_some()
                || source_state
                    .thread
                    .desktop
                    .as_ref()
                    .is_some_and(|d| d.workflow_run.is_some())
            {
                return Err(invalid("SOURCE_KIND_UNSUPPORTED"));
            }
            let config =
                engine.next_request_configuration(desktop(&source_state.thread).configuration);
            if config
                .profile
                .as_ref()
                .is_some_and(|profile| profile.workflow.is_some())
            {
                return Err(invalid("PROFILE_NOT_SUPPORTED"));
            }
            let source = engine
                .store
                .read_thread(&request.source_thread_id)
                .await
                .map_err(invalid)?;
            drop(source_state);
            let (mut prefix, mut sources) = match source.model_history_seed() {
                Some(seed) => engine
                    .store
                    .read_fork_snapshot_with_sources(&seed.snapshot_id)
                    .map_err(invalid)?,
                None => (Vec::new(), Vec::new()),
            };
            for mut turn in source.turns.clone() {
                if turn.status == TurnStatus::InProgress {
                    turn.items
                        .retain(|item| matches!(item, Item::UserMessage { .. }));
                    if turn.items.is_empty() {
                        break;
                    }
                    turn.status = TurnStatus::Completed;
                    turn.error = None;
                    turn.generation = None;
                    turn.instruction_snapshot = None;
                    turn.instruction_attribution = None;
                    prefix.push(turn);
                    sources.push(source.id.clone());
                    break;
                }
                prefix.push(turn);
                sources.push(source.id.clone());
            }
            let model = engine
                .configured_model(&config)
                .map_err(|_| invalid("MODEL_CONTEXT_INCOMPATIBLE"))?;
            engine.validate_fork_replay(&prefix, model.as_ref()).await?;
            let limit = if engine.limits.max_history_bytes == 0 {
                64 * 1024 * 1024
            } else {
                engine.limits.max_history_bytes.min(64 * 1024 * 1024)
            };
            let (snapshot_id, logical_bytes) = engine
                .store
                .write_fork_snapshot(prefix.clone(), sources, limit)
                .await
                .map_err(invalid)?;
            let thread_id = id();
            let base = Thread {
                conversation: Some(areal_protocol::Conversation::Side {
                    version: 2,
                    origin: areal_protocol::ConversationOrigin {
                        source_thread_id: source.id,
                        source_turn_id: prefix
                            .last()
                            .map(|turn| turn.id.clone())
                            .unwrap_or_default(),
                        boundary: "stableInput".into(),
                        snapshot_id: snapshot_id.clone(),
                    },
                    reference_snapshot: areal_protocol::HistorySeed {
                        snapshot_id,
                        turn_count: prefix.len(),
                        item_count: prefix.iter().map(|turn| turn.items.len()).sum(),
                        logical_bytes,
                    },
                    policy: areal_protocol::SidePolicy::ExecutableV2,
                    selection: None,
                }),
                goals: Default::default(),
                goal_owner: None,
                desktop: Some(DesktopState {
                    configuration: config,
                    ..Default::default()
                }),
                id: thread_id.clone(),
                session_id: thread_id.clone(),
                parent_thread_id: None,
                preview: String::new(),
                name: None,
                name_attempt_turn_id: None,
                model_provider: engine.model_provider(),
                created_at: now(),
                updated_at: now(),
                status: ThreadStatus::Idle,
                cwd: source.cwd,
                cli_version: env!("CARGO_PKG_VERSION").into(),
                source: "appServer".into(),
                ephemeral: false,
                turns: Vec::new(),
                history_archive: None,
                context_checkpoint: None,
                dynamic_tools: host
                    .as_ref()
                    .map(|_| {
                        let mut tools = vec![areal_protocol::desktop::browser_v1_tool()];
                        let computer = areal_protocol::desktop::computer_v1_tool();
                        if source.dynamic_tools.iter().any(|tool| {
                            tool.name == computer.name
                                && tool.description == computer.description
                                && tool.input_schema == computer.input_schema
                                && tool.output_schema == computer.output_schema
                        }) {
                            tools.push(computer);
                        }
                        tools
                    })
                    .unwrap_or_default(),
                toolset_revision: u64::from(host.is_some()),
            };
            let (mut thread, turn) = match request.first_input {
                Some(input) => {
                    let (thread, turn) = engine.prepare_turn(&base, input)?;
                    (thread, Some(turn))
                }
                None => (base, None),
            };
            let mut result = json!({"threadId":thread_id});
            if let Some(turn) = &turn {
                result["turnId"] = json!(turn.id);
            }
            remember(
                thread.desktop.as_mut().unwrap(),
                &identity,
                &request.request_id,
                method,
                hash.clone(),
                result,
            );
            let admission = turn
                .as_ref()
                .map(|_| engine.reserve_active_turn())
                .transpose()?;
            let registry = engine.managed_registry(&thread, false).map_err(invalid)?;
            let cell = Cell::new(
                thread.clone(),
                0,
                crate::tools::Bindings { registry, host },
                None,
            );
            let _creation = engine.thread_creation.lock().await;
            if engine.threads.read().await.len() >= engine.limits.max_threads {
                return Err(Error::Exhausted("thread capacity reached".into()));
            }
            if let Err(error) = engine.persist(&thread).await {
                if engine
                    .store
                    .read_thread(&thread_id)
                    .await
                    .is_ok_and(|saved| {
                        saved.desktop.as_ref().is_some_and(|data| {
                            receipt(data, &identity, &request.request_id, method, &hash)
                                .ok()
                                .flatten()
                                .is_some()
                        })
                    })
                {
                    cell.state.lock().await.poisoned = true;
                    engine.threads.write().await.insert(thread_id, cell);
                }
                return Err(error);
            }
            if let (Some(turn), Some(admission)) = (&turn, admission) {
                let mut state = cell.state.lock().await;
                engine.activate(
                    &cell,
                    &mut state,
                    turn,
                    engine.shutdown.child_token(),
                    admission,
                );
            }
            engine.threads.write().await.insert(thread_id, cell);
            Ok((thread, turn))
        })
        .await
    }

    pub async fn side_close(
        self: &Arc<Self>,
        identity: String,
        request: SideClose,
    ) -> Result<Value> {
        self.mutate(move |engine| async move {
            let method = "areal/side/close";
            let hash = digest(&request)?;
            let admission = engine.desktop.lifecycle.gate.lock().await;
            let cell = engine.raw_cell(&request.thread_id).await?;
            let mut settled = cell.settled.subscribe();
            {
                let mut state = cell.state.lock().await;
                if !state.thread.is_executable_side() { return Err(invalid("SIDE_POLICY_VIOLATION")); }
                let data = desktop(&state.thread);
                if let Some(result) = receipt(&data, &identity, &request.request_id, method, &hash)? { return Ok(close_reply(result)); }
                if let Some(previous) = data.receipts.iter().find(|r| r.method == method) {
                    return Ok(close_reply(previous.result.clone()));
                }
                if data.archived { return Err(invalid("THREAD_ARCHIVED")); }
                let mut candidate = state.thread.clone();
                let data = candidate.desktop.as_mut().unwrap();
                data.archived = true;
                data.prompt_prediction = None;
                data.queue.paused = true;
                data.queue.pause_reason = Some("sideClosed".into());
                data.queue.revision += 1;
                for item in &mut data.queue.items {
                    if item.status == "pending" { item.status = "cancelled".into(); }
                }
                remember(data, &identity, &request.request_id, method, hash,
                    json!({"requestId":request.request_id,"threadId":request.thread_id,"accepted":true,"cleanupConfirmed":false}));
                if let Err(error) = engine.persist(&candidate).await {
                    state.poisoned = true;
                    if let Some(active) = &state.active { active.cancel.cancel(); }
                    return Err(error);
                }
                state.thread = candidate;
                crate::prompt_prediction::invalidate(&mut state);
                if let Some(active) = &state.active { active.cancel.cancel(); }
                if let Some(owner) = &state.compaction_owner { owner.cancellation.cancel(); }
                cell.emit("areal/queue/updated", json!({"threadId":request.thread_id,"queue":state.thread.desktop.as_ref().unwrap().queue}));
            }
            drop(admission);
            let cleanup_engine = engine.clone();
            let cleanup_cell = cell.clone();
            let cleanup_request = request.clone();
            let cleanup_identity = identity.clone();
            let cleanup = engine.tasks.spawn(async move {
                let engine = cleanup_engine;
                let cell = cleanup_cell;
                let settled = settled.wait_for(|done| *done).await.is_ok();
                while cell.state.lock().await.compacting { tokio::time::sleep(Duration::from_millis(10)).await; }
                // Retained process records gate final confirmation after inspection.
                let _ = engine.close_managed(&cell, None).await;
                let hooks = engine.plugin_hooks_end(&cell).await;
                let apps = engine.close_thread_apps(&cleanup_request.thread_id).await;
                cell.bindings.write().await.host = None;
                let mut state = cell.state.lock().await;
                if settled && hooks.is_ok() && apps.is_ok() {
                    let mut candidate = state.thread.clone();
                    let record = candidate.desktop.as_mut().unwrap().receipts.iter_mut()
                        .find(|record| record.method == method && record.request_id == cleanup_request.request_id && record.identity == cleanup_identity).unwrap();
                    record.result["cleanupSettled"] = json!(true);
                    engine.persist(&candidate).await?;
                    state.thread = candidate;
                    engine.finish_side_close(&cell, &mut state).await?;
                }
                Ok::<(), Error>(())
            });
            let _ = tokio::time::timeout(Duration::from_secs(30), cleanup).await;
            let state = cell.state.lock().await;
            Ok(close_reply(state.thread.desktop.as_ref().unwrap().receipts.iter()
                .find(|record| record.method == method && record.request_id == request.request_id && record.identity == identity).unwrap().result.clone()))
        }).await
    }

    pub(crate) async fn finish_side_close(&self, cell: &Cell, state: &mut State) -> Result<()> {
        if !state.thread.is_executable_side() || super::retention::validate_archive(state).is_err()
        {
            return Ok(());
        }
        let mut candidate = state.thread.clone();
        let Some(record) = candidate.desktop.as_mut().and_then(|data| {
            data.receipts.iter_mut().find(|record| {
                record.method == "areal/side/close"
                    && record.result["cleanupSettled"] == true
                    && record.result["cleanupConfirmed"] != true
            })
        }) else {
            return Ok(());
        };
        record.result["cleanupConfirmed"] = json!(true);
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit("areal/thread/archived", json!({"threadId":cell.id}));
        Ok(())
    }
}
