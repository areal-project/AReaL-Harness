//! 任务配置会话只产生提案；确认复用原 Thread 与 Task 持久回执，不另建任务存储。
use super::*;
use areal_protocol::desktop::{ClientOptions, ConfigureThread, ThreadStart, TurnStart};
use sha2::{Digest, Sha256};

const MARKER: &str = "AREAL_TASK_DRAFT_V1";
const TARGET: &str = "Current scheduled task: ";

fn key(thread: &str, purpose: &str) -> String {
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("{MARKER}:{thread}:{purpose}").as_bytes())
    );
    format!(
        "{}-{}-4{}-a{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        &hash[17..20],
        &hash[20..32]
    )
}
fn hash(value: &Value) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(invalid)?)
    ))
}
fn text(value: Option<&str>, label: &str, max: usize) -> Result<String> {
    let value = value.ok_or_else(|| invalid(format!("缺少{label}")))?;
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(invalid(format!("{label}需要 1–{max} 个字符")));
    }
    Ok(value.trim().into())
}
fn options(
    zone: &str,
    cwd: &str,
    target: Option<&Value>,
    civil: Option<&ScheduleContext>,
) -> Result<ClientOptions> {
    let edit = if target.is_some() {
        "EDIT MODE: Return only changed objective and/or scheduleV2. Preserve unchanged frequency, selectors and time zone. For pause/resume/cancel use {kind:\"control\",action,message}. Cancel preserves history. Immediate execution uses the saved Task button 立即运行. Budgets, permissions and project binding cannot be changed here."
    } else {
        ""
    };
    let prompt = include_str!("draft-prompt.txt")
        .replace(
            "{purpose}",
            if target.is_some() {
                "edit the selected scheduled task"
            } else {
                "configure a task"
            },
        )
        .replace("{zone}", zone)
        .replace("{edit}", edit);
    let mut append = format!(
        "{MARKER}\nTime zone: {zone}\nWorkspace context: {}\nEach execution uses this exact working directory; projectRoot is the containment boundary, not a replacement cwd.",
        json!({"cwd":cwd})
    );
    if let Some(civil) = civil {
        append.push_str(&format!("\nCore current civil time: {}T{} in {}. Use structured civil rules; Core resolves and saves the original intent.", civil.local_date, civil.local_time, civil.time_zone));
    }
    if let Some(target) = target {
        append.push_str(&format!("\n{TARGET}{target}"));
    }
    serde_json::from_value(json!({"readOnly":true,"toolAllowlist":[],"maxModelRounds":1,"systemPrompt":prompt,"appendInstructions":append})).map_err(invalid)
}
fn target(task: &Task) -> Value {
    json!({"taskId":task.id,"expectedRevision":task.revision,"objective":task.objective,"schedule":task.schedule,"scheduleV2":task.schedule_v2,"nextRunAt":task.next_run_at,"interactionMode":task.interaction_mode,"paused":task.paused})
}
fn configuration(thread: &Thread) -> Result<&areal_protocol::desktop::EffectiveConfig> {
    let config = thread
        .desktop
        .as_ref()
        .map(|desktop| &desktop.configuration)
        .ok_or_else(|| invalid("这不是有效的任务配置会话，请重新创建。"))?;
    if !config
        .options
        .append_instructions
        .starts_with(&format!("{MARKER}\n"))
        || !config.options.read_only
        || config
            .options
            .tool_allowlist
            .as_ref()
            .is_none_or(|tools| !tools.is_empty())
    {
        return Err(invalid("这不是有效的任务配置会话，请重新创建。"));
    }
    Ok(config)
}
fn saved_target(thread: &Thread) -> Result<Option<Value>> {
    configuration(thread)?
        .options
        .append_instructions
        .lines()
        .find_map(|line| line.strip_prefix(TARGET))
        .map(|line| serde_json::from_str(line).map_err(invalid))
        .transpose()
}
fn zone(thread: &Thread) -> Result<String> {
    text(
        configuration(thread)?
            .options
            .append_instructions
            .lines()
            .nth(1)
            .and_then(|line| line.strip_prefix("Time zone: ")),
        "时区",
        128,
    )
}
fn reply(raw: &str) -> Result<Value> {
    let raw = raw.trim();
    let raw = if let Some(raw) = raw
        .strip_prefix("```json\n")
        .or_else(|| raw.strip_prefix("```\n"))
    {
        raw.strip_suffix("\n```").unwrap_or(raw)
    } else {
        raw
    };
    let value: Value =
        serde_json::from_str(raw).map_err(|_| invalid("模型返回的安排格式无效，请重新描述。"))?;
    if !value.is_object() {
        return Err(invalid("模型返回的安排格式无效，请重新描述。"));
    }
    Ok(value)
}
fn proposal(answer: &Value, users: &[String], target: Option<&Value>, zone: &str) -> Result<Value> {
    if answer["kind"] == "control" && target.is_some() {
        let action = answer["action"]
            .as_str()
            .filter(|action| matches!(*action, "pause" | "resume" | "cancel"))
            .ok_or_else(|| invalid("当前只能暂停／恢复／取消任务。"))?;
        return Ok(
            json!({"taskId":target.unwrap()["taskId"],"expectedRevision":target.unwrap()["expectedRevision"],"action":action}),
        );
    }
    if answer["kind"] != "proposal" {
        return Err(invalid("模型没有返回可确认的安排，请补充说明后重试。"));
    }
    if target.is_some()
        && answer.as_object().unwrap().keys().any(|field| {
            ![
                "kind",
                "message",
                "objective",
                "schedule",
                "scheduleV2",
                "interactionMode",
                "timeZone",
            ]
            .contains(&field.as_str())
        })
    {
        return Err(invalid(
            "当前只能修改任务内容和时间，或暂停／恢复／取消任务。",
        ));
    }
    let mut result = if let Some(target) = target {
        json!({"taskId":target["taskId"],"expectedRevision":target["expectedRevision"]})
    } else {
        json!({"mode":"scheduled","interactionMode":"interactive"})
    };
    if target.is_none() || answer.get("objective").is_some() {
        result["objective"] = json!(text(answer["objective"].as_str(), "任务目标", 4000)?);
    }
    if target.is_none() || answer.get("scheduleV2").is_some() || answer.get("schedule").is_some() {
        if answer.get("scheduleV2").is_some() && answer.get("schedule").is_some() {
            return Err(invalid("请只提供一份执行计划。"));
        }
        let mut intent = answer.get("scheduleV2").cloned().unwrap_or(Value::Null);
        if intent.is_null() {
            let legacy = &answer["schedule"];
            let at = legacy["at"]
                .as_str()
                .ok_or_else(|| invalid("定时任务需要明确的执行时间。"))?;
            let interval = legacy.get("intervalSeconds").cloned().or_else(|| {
                target
                    .and_then(|target| {
                        target["schedule"]["intervalSeconds"]
                            .as_u64()
                            .or_else(|| target["scheduleV2"]["rule"]["intervalSeconds"].as_u64())
                    })
                    .map(Value::from)
            });
            let mut rule = if chrono::DateTime::parse_from_rfc3339(at).is_ok() {
                json!({"kind":if interval.is_some(){"intervalIso"}else{"onceIso"},"atIso":at})
            } else if at.is_ascii() && at.len() == 19 && at.ends_with(":00") {
                json!({"kind":if interval.is_some(){"intervalLocal"}else{"onceLocal"},"timeZone":zone,"localTime":&at[11..16],"date":{"kind":"date","date":&at[..10]}})
            } else {
                return Err(invalid("模型返回的时间缺少明确日期，请补充说明。"));
            };
            if let Some(interval) = interval {
                rule["intervalSeconds"] = interval;
            }
            intent = json!({"version":1,"rule":rule});
        }
        if intent.get("misfire").is_none() {
            intent["misfire"] = json!({"kind":"skip","maxLatenessSeconds":300});
        }
        if intent.get("overlap").is_none() {
            intent["overlap"] = json!("skip");
        }
        let _: ScheduleIntent = serde_json::from_value(intent.clone())
            .map_err(|_| invalid("模型返回的执行时间无效。"))?;
        let interval = intent["rule"]["kind"]
            .as_str()
            .is_some_and(|kind| matches!(kind, "interval" | "intervalLocal" | "intervalIso"));
        if interval
            && users.iter().rev().any(|user| {
                ["工作日", "周一至周五", "周一到周五", "每月", "月末", "月底"]
                    .iter()
                    .any(|marker| user.contains(marker))
            })
        {
            return Err(invalid(
                "工作日或每月安排不能换算成固定秒间隔，请补充说明日历安排。",
            ));
        }
        result["scheduleV2"] = intent;
    }
    if let Some(target) = target {
        if answer
            .get("interactionMode")
            .is_some_and(|mode| mode != &target["interactionMode"])
        {
            return Err(invalid("此次修改不能改变任务权限或提问策略。"));
        }
        if result.get("objective").is_none() && result.get("scheduleV2").is_none() {
            return Err(invalid("没有可保存的修改，请说明要调整的内容。"));
        }
    } else if let Some(limits) = answer.get("limits") {
        let limits = limits
            .as_object()
            .ok_or_else(|| invalid("模型返回的停止条件无效。"))?;
        for (field, value) in limits {
            let quote = answer["limitSources"][field].as_str().unwrap_or_default();
            if !["tokenBudget", "maxTurns", "maxActiveSeconds"].contains(&field.as_str())
                || !value
                    .as_u64()
                    .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
                || quote.trim().is_empty()
                || !users.iter().any(|user| user.contains(quote))
            {
                return Err(invalid("停止条件缺少你的明确说明，请补充后重新生成。"));
            }
            result[field] = value.clone();
        }
    }
    Ok(result)
}

impl Engine {
    async fn draft_thread(&self, id: &str) -> Result<Thread> {
        let thread = self.read(id, true).await?;
        configuration(&thread)?;
        Ok(thread)
    }
    async fn draft_created_task(&self, owner: &str, thread: &Thread) -> Result<Option<Value>> {
        let receipt = self
            .find_request(owner, &key(&thread.id, "confirm"))
            .await?;
        let task = receipt["data"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row["status"] == "completed"
                        && row["method"] == "areal/task/create"
                        && row["result"]["id"].is_string()
                })
            })
            .and_then(|row| row["result"]["id"].as_str());
        match task {
            Some(id) => Ok(Some(self.task_summary(id).await?)),
            None => Ok(None),
        }
    }
    async fn draft_committed(
        &self,
        owner: &str,
        thread: &Thread,
        turn: Option<&str>,
    ) -> Result<Option<Value>> {
        let receipt = self
            .find_request(
                owner,
                &key(
                    &thread.id,
                    &format!("draft-confirm:{}", turn.unwrap_or_default()),
                ),
            )
            .await?;
        let task = receipt["data"]
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row["status"] == "completed"
                        && row["method"] == "areal/task/draft"
                        && row["result"]["id"].is_string()
                })
            })
            .and_then(|row| row["result"]["id"].as_str());
        match task {
            Some(id) => Ok(Some(self.task_summary(id).await?)),
            None => Ok(None),
        }
    }
    async fn draft_view(&self, owner: &str, thread: &Thread) -> Result<Value> {
        let zone = zone(thread)?;
        let target = saved_target(thread)?;
        let created_in_thread = self.draft_created_task(owner, thread).await?.is_some();
        let mut seen_committed = !created_in_thread && target.is_some();
        let mut users = Vec::new();
        let mut messages = Vec::new();
        let mut selected = Value::Null;
        let mut error = String::new();
        let mut display = serde_json::to_value(thread).map_err(invalid)?;
        for (index, turn) in thread.turns.iter().enumerate() {
            let value = serde_json::to_value(turn).map_err(invalid)?;
            let user = value["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["type"] == "userMessage")
                .flat_map(|item| item["content"].as_array().into_iter().flatten())
                .filter_map(|item| {
                    (item["type"] == "text")
                        .then(|| item["text"].as_str())
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !user.is_empty() {
                messages.push(json!({"id":format!("{}:user",turn.id),"role":"user","text":user}));
            }
            users.push(user);
            let mut message = None;
            let mut proposed = Value::Null;
            let mut failure = String::new();
            if turn.status != TurnStatus::InProgress {
                if self
                    .draft_committed(owner, thread, Some(&turn.id))
                    .await?
                    .is_some()
                {
                    message = Some(
                        if seen_committed {
                            "已保存修改。"
                        } else {
                            seen_committed = true;
                            "已创建任务。"
                        }
                        .to_owned(),
                    );
                } else {
                    let parsed = (|| -> Result<(String, Value)> {
                        if turn.status != TurnStatus::Completed {
                            return Err(invalid(
                                "模型未完成这次安排。你的描述已保留，可以补充说明后重试。",
                            ));
                        }
                        let raw = value["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|item| {
                                item["type"] == "agentMessage" && item["phase"] != "commentary"
                            })
                            .last()
                            .and_then(|item| item["text"].as_str())
                            .unwrap_or_default();
                        let answer = reply(raw)?;
                        if answer["kind"] == "question" {
                            return Ok((
                                text(answer["message"].as_str(), "模型回复", 4000)?,
                                Value::Null,
                            ));
                        }
                        let proposed = proposal(&answer, &users, target.as_ref(), &zone)?;
                        Ok((
                            if index + 1 == thread.turns.len() {
                                "正在保存安排。"
                            } else {
                                "此安排未保存。"
                            }
                            .into(),
                            proposed,
                        ))
                    })();
                    match parsed {
                        Ok((text, value)) => {
                            message = Some(text);
                            proposed = value;
                        }
                        Err(cause) => {
                            failure = cause.to_string();
                            message = Some(format!("这次安排未保存。{failure}"));
                        }
                    }
                }
            }
            if let Some(message) = &message {
                messages.push(
                    json!({"id":format!("{}:assistant",turn.id),"role":"assistant","text":message}),
                );
            }
            if let Some(items) = display["turns"][index]["items"].as_array_mut() {
                let last = items.iter().rposition(|item| {
                    item["type"] == "agentMessage" && item["phase"] != "commentary"
                });
                *items = items
                    .iter()
                    .enumerate()
                    .filter_map(|(at, item)| {
                        if item["type"] != "agentMessage" {
                            Some(item.clone())
                        } else if Some(at) == last {
                            message.as_ref().map(|message| {
                                let mut item = item.clone();
                                item["text"] = json!(message);
                                item
                            })
                        } else {
                            None
                        }
                    })
                    .collect();
            }
            if index + 1 == thread.turns.len() {
                selected = proposed;
                error = failure;
            }
        }
        let mut value = json!({"threadId":thread.id,"turnId":thread.turns.last().map(|turn| &turn.id),"running":thread.turns.last().is_some_and(|turn| turn.status==TurnStatus::InProgress),"messages":messages,"digest":if selected.is_null(){Value::Null}else{json!(hash(&selected)?)},"proposal":selected,"error":error,"timeZone":zone,"thread":display});
        if let Some(task) = match self
            .draft_committed(
                owner,
                thread,
                thread.turns.last().map(|turn| turn.id.as_str()),
            )
            .await?
        {
            Some(task) => Some(task),
            None if target.is_none() => self.draft_created_task(owner, thread).await?,
            None => None,
        } {
            value["task"] = task;
            value["proposal"] = Value::Null;
            value["digest"] = Value::Null;
            value["error"] = json!("");
        }
        let schedule = value["task"]
            .get("scheduleV2")
            .or_else(|| value["proposal"].get("scheduleV2"));
        if let Some(schedule) = schedule {
            let preview: SchedulePreview =
                serde_json::from_value(json!({"schedule":schedule,"timeZone":zone,"count":5}))
                    .map_err(invalid)?;
            match self.task_schedule_preview(preview) {
                Ok(preview) => value["preview"] = serde_json::to_value(preview).map_err(invalid)?,
                Err(cause) => {
                    value["proposal"] = Value::Null;
                    value["error"] = json!(cause.to_string());
                }
            }
        }
        Ok(value)
    }
    pub async fn task_draft(
        self: &Arc<Self>,
        owner: String,
        request: TaskDraftRequest,
    ) -> Result<Value> {
        if matches!(
            request.operation,
            TaskDraftOperation::TaskDraftRead | TaskDraftOperation::TaskDraftHistory
        ) {
            return self.task_draft_inner(owner, request).await;
        }
        let request_id = if matches!(request.operation, TaskDraftOperation::TaskDraftConfirm) {
            let stable = key(
                request.thread_id.as_deref().unwrap_or_default(),
                &format!(
                    "draft-confirm:{}",
                    request.turn_id.as_deref().unwrap_or_default()
                ),
            );
            if request
                .request_id
                .as_ref()
                .is_some_and(|request| request != &stable)
            {
                return Err(invalid("确认请求与原轮次身份不匹配"));
            }
            stable
        } else {
            request
                .request_id
                .clone()
                .or_else(|| request.draft_id.clone())
                .ok_or_else(|| invalid("缺少原请求标识"))?
        };
        let parameters = serde_json::to_value(&request).map_err(invalid)?;
        let result = self
            .management_submission(
                owner.clone(),
                request_id,
                "areal/task/draft".into(),
                parameters,
                move |engine| async move {
                    match engine.task_draft_inner(owner, request).await {
                        Ok(value) => json!({"result":value}),
                        Err(cause) => json!({"error":{"code":-32009,"message":cause.to_string()}}),
                    }
                },
            )
            .await?;
        if let Some(error) = result.get("error") {
            return Err(invalid(
                error["message"].as_str().unwrap_or("任务配置未完成"),
            ));
        }
        result
            .get("result")
            .cloned()
            .ok_or_else(|| invalid("任务配置回执无效"))
    }

    async fn task_draft_inner(
        self: &Arc<Self>,
        owner: String,
        request: TaskDraftRequest,
    ) -> Result<Value> {
        match request.operation {
            TaskDraftOperation::TaskDraftStart => {
                let request_id = text(request.draft_id.as_deref(), "配置草稿标识", 128)?;
                uuid::Uuid::parse_str(&request_id).map_err(invalid)?;
                let zone = text(request.time_zone.as_deref(), "时区", 128)?;
                self.task_schedule_context(ScheduleContextInput {
                    time_zone: zone.clone(),
                })?;
                let task = if let Some(id) = &request.task_id {
                    let task = self.task_read(id).await?;
                    if task.mode != TaskMode::Scheduled {
                        return Err(invalid("只有定时任务具有管理会话。"));
                    }
                    Some(task)
                } else {
                    None
                };
                if let Some(task) = &task {
                    let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
                    for cell in cells {
                        let previous = cell.state.lock().await.thread.clone();
                        if configuration(&previous).is_err() {
                            continue;
                        }
                        let created = self.draft_created_task(&owner, &previous).await?;
                        if created
                            .as_ref()
                            .is_some_and(|created| created["id"] == task.id)
                        {
                            if saved_target(&previous)?.is_none() {
                                let current = configuration(&previous)?;
                                self.configure_thread_as(
                                    owner.clone(),
                                    ConfigureThread {
                                        request_id: None,
                                        thread_id: previous.id.clone(),
                                        expected_revision: current.revision,
                                        options: Some(options(
                                            &zone,
                                            &previous.cwd,
                                            Some(&target(task)),
                                            None,
                                        )?),
                                        agent_profile: None,
                                        model: None,
                                        reset_model: false,
                                        parameters: None,
                                        selected_skills: None,
                                    },
                                )
                                .await?;
                            }
                            return Ok(json!({"threadId":previous.id,"requestId":request_id}));
                        }
                    }
                }
                let cwd = if let Some(task) = &task {
                    self.read(task.thread_id.as_deref().ok_or(Error::NotFound)?, false)
                        .await?
                        .cwd
                } else {
                    request
                        .cwd
                        .clone()
                        .or_else(|| {
                            self.runtime
                                .as_ref()
                                .map(|runtime| runtime.workspace.to_string_lossy().into_owned())
                        })
                        .ok_or_else(|| invalid("缺少工作目录"))?
                };
                let host = self
                    .schedule_host(&owner)
                    .await
                    .ok_or_else(|| invalid("任务 Host 未连接"))?;
                let target = task.as_ref().map(target);
                let start:ThreadStart=serde_json::from_value(json!({"requestId":request_id,"cwd":cwd,"options":options(&zone,&cwd,target.as_ref(),None)?,"model":request.model,"parameters":request.parameters.unwrap_or_default()})).map_err(invalid)?;
                let thread = self.create_configured(owner, start, host).await?;
                configuration(&thread)?;
                Ok(json!({"threadId":thread.id,"requestId":request_id}))
            }
            TaskDraftOperation::TaskDraftHistory => {
                let task_id = text(request.task_id.as_deref(), "任务", 128)?;
                self.task_read(&task_id).await?;
                let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
                for cell in cells {
                    let thread = cell.state.lock().await.thread.clone();
                    if configuration(&thread).is_err() {
                        continue;
                    }
                    if self
                        .draft_created_task(&owner, &thread)
                        .await?
                        .is_some_and(|task| task["id"] == task_id)
                    {
                        let view = self.draft_view(&owner, &thread).await?;
                        return Ok(
                            json!({"threadId":thread.id,"messages":view["messages"],"timeZone":view["timeZone"]}),
                        );
                    }
                }
                Ok(json!({"messages":[]}))
            }
            TaskDraftOperation::TaskDraftRead => {
                let id = text(request.thread_id.as_deref(), "配置会话", 128)?;
                self.draft_view(&owner, &self.draft_thread(&id).await?)
                    .await
            }
            TaskDraftOperation::TaskDraftSend => {
                let id = text(request.thread_id.as_deref(), "配置会话", 128)?;
                let thread = self.draft_thread(&id).await?;
                let zone = text(request.time_zone.as_deref(), "时区", 128)?;
                let civil = self.task_schedule_context(ScheduleContextInput {
                    time_zone: zone.clone(),
                })?;
                let mut target = saved_target(&thread)?;
                if target.is_none() && self.draft_created_task(&owner, &thread).await?.is_some() {
                    return Err(invalid("此安排已经创建，请从列表查看任务或开始新的安排。"));
                }
                if let Some(target) = &mut target {
                    let task = self
                        .task_read(target["taskId"].as_str().ok_or(Error::NotFound)?)
                        .await?;
                    if task.cancelled {
                        return Err(invalid("此任务已取消，不能继续修改。"));
                    }
                    *target = super::draft::target(&task);
                }
                let mut input = request.input;
                if input.is_empty() {
                    if let Some(text) = request.text.filter(|text| !text.trim().is_empty()) {
                        input.push(Input::Text {
                            text,
                            text_elements: vec![],
                            mcp_content: None,
                        });
                    }
                }
                if input.is_empty() {
                    return Err(invalid("消息不能为空"));
                }
                let configuration = configuration(&thread)?;
                let configured = self
                    .configure_thread_as(
                        owner.clone(),
                        ConfigureThread {
                            request_id: None,
                            thread_id: id.clone(),
                            expected_revision: configuration.revision,
                            options: Some(options(
                                &zone,
                                &thread.cwd,
                                target.as_ref(),
                                Some(&civil),
                            )?),
                            agent_profile: None,
                            model: request.model,
                            reset_model: false,
                            parameters: request
                                .effort
                                .map(|reasoning_effort| {
                                    serde_json::from_value(
                                        json!({"reasoningEffort":reasoning_effort}),
                                    )
                                    .map_err(invalid)
                                })
                                .transpose()?,
                            selected_skills: None,
                        },
                    )
                    .await?;
                let started = self
                    .start_durable(
                        owner,
                        TurnStart {
                            admission_guard: None,
                            interaction_mode: None,
                            request_id: text(request.request_id.as_deref(), "请求标识", 128)?,
                            thread_id: id.clone(),
                            input,
                            expected_config_revision: Some(configured.revision),
                        },
                        false,
                    )
                    .await?;
                Ok(
                    json!({"threadId":id,"turnId":started["turn"].get("id").unwrap_or(&started["turnId"])}),
                )
            }
            TaskDraftOperation::TaskDraftConfirm => {
                let id = text(request.thread_id.as_deref(), "配置会话", 128)?;
                let thread = self.draft_thread(&id).await?;
                if let Some(task) = self
                    .draft_committed(
                        &owner,
                        &thread,
                        thread.turns.last().map(|turn| turn.id.as_str()),
                    )
                    .await?
                {
                    return Ok(task);
                }
                let view = self.draft_view(&owner, &thread).await?;
                if view["proposal"].is_null()
                    || view["turnId"].as_str() != request.turn_id.as_deref()
                    || view["digest"].as_str() != request.digest.as_deref()
                {
                    return Err(invalid("安排已经变化，请确认最新摘要。"));
                }
                let mut values = view["proposal"].clone();
                if let Some(target) = saved_target(&thread)? {
                    let task = self
                        .task_read(target["taskId"].as_str().ok_or(Error::NotFound)?)
                        .await?;
                    if task.revision != target["expectedRevision"].as_u64().unwrap_or_default() {
                        return Err(Error::Conflict);
                    }
                    values["requestId"] = json!(key(
                        &id,
                        &format!("edit:{}", request.turn_id.as_deref().unwrap_or_default())
                    ));
                    if let Some(action) = values["action"].as_str().map(str::to_owned) {
                        values.as_object_mut().unwrap().remove("action");
                        return self
                            .task_control(
                                owner,
                                action,
                                serde_json::from_value(values).map_err(invalid)?,
                            )
                            .await;
                    }
                    return self
                        .task_update(owner, serde_json::from_value(values).map_err(invalid)?)
                        .await;
                }
                let host = self
                    .schedule_host(&owner)
                    .await
                    .ok_or_else(|| invalid("任务 Host 未连接"))?;
                let start: ThreadStart = serde_json::from_value(
                    json!({"requestId":key(&id,"execution"),"cwd":thread.cwd}),
                )
                .map_err(invalid)?;
                let execution = self.create_configured(owner.clone(), start, host).await?;
                values["threadId"] = json!(execution.id);
                values["requestId"] = json!(key(&id, "confirm"));
                self.task_create(owner, serde_json::from_value(values).map_err(invalid)?)
                    .await
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn schedule() -> Value {
        json!({"version":1,"rule":{"kind":"onceLocal","timeZone":"Asia/Shanghai","localTime":"09:00","date":{"kind":"next"}}})
    }
    #[test]
    fn draft_proposal_preserves_civil_intent_and_requires_explicit_budget_evidence() {
        let mut answer = json!({"kind":"proposal","objective":"整理项目","scheduleV2":schedule(),"limits":{"maxTurns":5},"limitSources":{"maxTurns":"最多五轮"}});
        assert!(proposal(&answer, &[], None, "Asia/Shanghai").is_err());
        let result = proposal(&answer, &["最多五轮".into()], None, "Asia/Shanghai").unwrap();
        assert_eq!(result["maxTurns"], 5);
        assert_eq!(result["scheduleV2"]["rule"], schedule()["rule"]);
        assert_eq!(
            result["scheduleV2"]["misfire"],
            json!({"kind":"skip","maxLatenessSeconds":300})
        );
        answer["limits"]["tokens"] = json!(10);
        assert!(proposal(&answer, &["最多五轮".into()], None, "Asia/Shanghai").is_err());
    }
    #[test]
    fn draft_edits_bind_revision_and_cannot_change_permissions_or_binding() {
        let target = json!({"taskId":"task","expectedRevision":7,"interactionMode":"interactive"});
        assert_eq!(
            proposal(
                &json!({"kind":"control","action":"pause"}),
                &[],
                Some(&target),
                "UTC"
            )
            .unwrap(),
            json!({"taskId":"task","expectedRevision":7,"action":"pause"})
        );
        assert!(
            proposal(
                &json!({"kind":"proposal","objective":"new","taskId":"other"}),
                &[],
                Some(&target),
                "UTC"
            )
            .is_err()
        );
        assert!(
            proposal(
                &json!({"kind":"proposal","objective":"new","interactionMode":"headless"}),
                &[],
                Some(&target),
                "UTC"
            )
            .is_err()
        );
    }
    #[test]
    fn structured_calendar_requirements_cannot_be_replaced_by_seconds() {
        let answer = json!({"kind":"proposal","objective":"report","scheduleV2":{"version":1,"rule":{"kind":"intervalLocal","timeZone":"UTC","localTime":"09:00","date":{"kind":"next"},"intervalSeconds":86400}}});
        assert!(proposal(&answer, &["工作日早上九点".into()], None, "UTC").is_err());
    }
}
