//! 任务通信使用独立授权与订阅，不借用执行 Session 的客户端连接。
use super::*;
use areal_protocol::tasks::*;

areal_protocol::method_catalog! {
    "areal/task/create" => Mutation, Task;
    "areal/task/schedule/preview" => Read;
    "areal/task/schedule/context" => Read;
    "areal/task/update" => Mutation, Task;
    "areal/task/runNow" => Mutation, Task;
    "areal/task/list" => Read;
    "areal/task/read" => Read;
    "areal/task/runs/list" => Read;
    "areal/task/run/read" => Read;
    "areal/task/pause" => Mutation, Task;
    "areal/task/resume" => Mutation, Task;
    "areal/task/cancel" => Mutation, Task;
    "areal/task/delete" => Mutation, Task;
    "areal/task/stopRun" => Mutation, Task;
    "areal/task/resumeRun" => Mutation, Task;
    "areal/task/subscribe" => Subscription;
    "areal/task/unsubscribe" => Subscription;
    "areal/channel/read" => Read;
    "areal/channel/reply" => Mutation, Task;
    "areal/inbox/list" => Read;
}

pub(crate) async fn authorize(
    engine: &Engine,
    principal: &auth::Principal,
    id: &str,
) -> Result<Task, RpcError> {
    engine
        .task_read_for_threads(id, principal.thread_ids.as_ref())
        .await
        .map_err(map_error)
}

pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    principal: &auth::Principal,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let authorized = if let Some(id) = params["taskId"].as_str() {
        Some(authorize(engine, principal, id).await?)
    } else {
        None
    };
    match method {
        "areal/task/schedule/preview" => engine
            .task_schedule_preview(parse(params)?)
            .map(|v| json!(v))
            .map_err(map_error),
        "areal/task/schedule/context" => engine
            .task_schedule_context(parse(params)?)
            .map(|v| json!(v))
            .map_err(map_error),
        "areal/task/create" => {
            let request: TaskCreate = parse(params)?;
            if (request.mode == TaskMode::Scheduled && principal.thread_ids.is_some())
                || request
                    .thread_id
                    .as_ref()
                    .is_some_and(|id| !principal.sees(id))
                || (principal.thread_ids.is_some() && request.thread_id.is_none())
            {
                return Err(RpcError {
                    code: -32003,
                    message: "task binding permission denied".into(),
                    data: Some(
                        json!({"reason":"PERMISSION_DENIED","outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
                    ),
                });
            }
            engine
                .task_create(principal.id.clone(), request)
                .await
                .map_err(atomic_mutation_error)
                .map_err(map_error)
        }
        "areal/task/update" => engine
            .task_update_for_threads(
                principal.id.clone(),
                parse(params)?,
                principal.thread_ids.as_ref(),
            )
            .await
            .map_err(atomic_mutation_error)
            .map_err(map_error),
        "areal/task/runNow" => {
            let result = engine
                .task_run_now_for_threads(
                    principal.id.clone(),
                    parse(params)?,
                    principal.thread_ids.as_ref(),
                )
                .await
                .map_err(atomic_mutation_error)
                .map_err(map_error)?;
            match result {
                areal_engine::TaskRunNowAdmission::Accepted(value) => Ok(json!(value)),
                areal_engine::TaskRunNowAdmission::ActiveRun {
                    task_id,
                    run_id,
                    revision,
                } => Err(RpcError {
                    code: -32009,
                    message: "task already has an active Run".into(),
                    data: Some(
                        json!({"reason":"activeRun","taskId":task_id,"runId":run_id,"revision":revision,"outcome":{"kind":"rejected"},"recovery":{"kind":"none"}}),
                    ),
                }),
            }
        }
        "areal/task/read" => {
            let _: TaskTarget = parse(params)?;
            let task = authorized.ok_or_else(|| RpcError::invalid("taskId required"))?;
            engine
                .task_summary_for_threads(&task.id, principal.thread_ids.as_ref())
                .await
                .map_err(map_error)
        }
        "areal/task/runs/list" => Ok(json!(
            engine
                .task_runs_list_for_threads(parse(params)?, principal.thread_ids.as_ref())
                .await
                .map_err(map_error)?
        )),
        "areal/task/run/read" => Ok(json!(
            engine
                .task_run_read_for_threads(parse(params)?, principal.thread_ids.as_ref())
                .await
                .map_err(map_error)?
        )),
        "areal/task/list" | "areal/inbox/list" => {
            let p: TaskList = parse(params)?;
            let limit = p.limit.unwrap_or(30);
            if !(1..=100).contains(&limit) {
                return Err(RpcError::invalid("limit must be 1..100"));
            }
            let mut rows = Vec::new();
            for task in engine
                .task_list_for_threads(principal.thread_ids.as_ref())
                .await
                .map_err(map_error)?
                .into_iter()
            {
                if method == "areal/task/list" {
                    if p.after.as_ref().is_none_or(|id| task.id > *id) {
                        rows.push((task.id.clone(), Engine::task_projection(&task)));
                    }
                } else {
                    for message in &task.messages {
                        if message.kind != "question"
                            || message.status != "pending"
                            || message.expires_at.is_some_and(|at| {
                                at <= std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs() as i64
                            })
                        {
                            continue;
                        }
                        let cursor = format!("{}/{}", task.id, message.id);
                        if p.after.as_ref().is_none_or(|id| cursor > *id) {
                            rows.push((cursor,json!({"taskId":task.id,"objective":task.objective,"message":message})));
                        }
                    }
                }
            }
            rows.sort_by(|a, b| a.0.cmp(&b.0));
            let original = rows.len();
            rows.truncate(limit);
            let mut bytes = 0;
            rows.retain(|(_, v)| {
                let size = serde_json::to_vec(v).map_or(usize::MAX, |s| s.len());
                let keep = bytes == 0 || bytes + size <= 131072;
                bytes = bytes.saturating_add(size);
                keep
            });
            let more = rows.len() < original;
            let next = if more {
                rows.last().map(|r| r.0.clone())
            } else {
                None
            };
            Ok(json!({"data":rows.into_iter().map(|(_,v)|v).collect::<Vec<_>>(),"nextCursor":next}))
        }
        "areal/task/pause"
        | "areal/task/resume"
        | "areal/task/cancel"
        | "areal/task/delete"
        | "areal/task/stopRun"
        | "areal/task/resumeRun" => engine
            .task_control_for_threads(
                principal.id.clone(),
                method.rsplit('/').next().unwrap().into(),
                parse(params)?,
                principal.thread_ids.as_ref(),
            )
            .await
            .map_err(atomic_mutation_error)
            .map_err(map_error),
        "areal/channel/read" => {
            let request: ChannelRead = parse(params)?;
            let result = engine
                .channel_read_for_threads(request.clone(), principal.thread_ids.as_ref())
                .await
                .map_err(map_error)?;
            authorize(engine, principal, &request.task_id).await?;
            Ok(result)
        }
        "areal/channel/reply" => engine
            .channel_reply_for_threads(
                principal.id.clone(),
                parse(params)?,
                principal.thread_ids.as_ref(),
            )
            .await
            .map_err(control_mutation_error)
            .map_err(map_error),
        _ => Err(RpcError::method()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 先固定保存契约：修改必须有授权、版本与幂等键，且不得改变暂停状态或已有身份。
    #[tokio::test]
    async fn scheduled_update_is_authorized_versioned_and_durable() {
        let dir = tempfile::tempdir().unwrap();
        let model = Arc::new(
            areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
                .unwrap(),
        );
        let engine = Engine::open(dir.path(), model, areal_engine::Limits::default()).unwrap();
        let thread = engine.create(engine.default_cwd()).await.unwrap();
        let owner = auth::Principal::embedded();
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86400;
        let created = dispatch(
            &engine,
            &owner,
            "areal/task/create",
            json!({
                "requestId":"create-edit-test", "mode":"scheduled", "objective":"original",
                "threadId":thread.id, "schedule":{"at":at,"intervalSeconds":86400}
            }),
        )
        .await
        .unwrap();
        let paused = dispatch(&engine, &owner, "areal/task/pause", json!({
            "requestId":"pause-edit-test", "taskId":created["id"], "expectedRevision":created["revision"]
        })).await.unwrap();
        let request = json!({"requestId":"edit-test", "taskId":created["id"],
            "expectedRevision":paused["revision"], "objective":"updated", "schedule":{"at":at+3600,"intervalSeconds":86400}});
        let denied = auth::Principal {
            thread_ids: Some(Default::default()),
            ..(*owner).clone()
        };
        assert_eq!(
            dispatch(&engine, &denied, "areal/task/update", request.clone())
                .await
                .unwrap_err()
                .code,
            -32003
        );
        validate("requests", "areal/task/update", &request);
        let updated = dispatch(&engine, &owner, "areal/task/update", request.clone())
            .await
            .unwrap();
        validate("responses", "areal/task/update", &updated);
        assert_eq!(updated["id"], created["id"]);
        assert_eq!(updated["threadId"], created["threadId"]);
        assert_eq!(updated["objective"], "updated");
        assert_eq!(updated["nextRunAt"], at + 3600);
        assert_eq!(updated["paused"], true);
        assert_eq!(updated["runs"], json!([]));
        let scoped = auth::Principal {
            thread_ids: Some([thread.id.clone()].into()),
            ..(*owner).clone()
        };
        assert_eq!(
            dispatch(&engine, &scoped, "areal/task/update", request.clone())
                .await
                .unwrap(),
            updated
        );
        assert_eq!(dispatch(&engine,&scoped,"areal/task/pause",json!({"requestId":"pause-edit-test","taskId":created["id"],"expectedRevision":created["revision"]})).await.unwrap(),paused);

        assert_eq!(
            dispatch(&engine, &owner, "areal/task/update", request.clone())
                .await
                .unwrap(),
            updated
        );
        let mut stale = request.clone();
        stale["requestId"] = json!("stale-edit");
        assert!(
            dispatch(&engine, &owner, "areal/task/update", stale)
                .await
                .is_err()
        );
        let mut invalid = request.clone();
        invalid["requestId"] = json!("invalid-edit");
        invalid["expectedRevision"] = updated["revision"].clone();
        invalid["schedule"]["intervalSeconds"] = json!(0);
        assert!(
            dispatch(&engine, &owner, "areal/task/update", invalid)
                .await
                .is_err()
        );
        engine.shutdown().await;
        drop(engine);
        let model = Arc::new(
            areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
                .unwrap(),
        );
        let reopened = Engine::open(dir.path(), model, areal_engine::Limits::default()).unwrap();
        let restored = dispatch(
            &reopened,
            &owner,
            "areal/task/read",
            json!({"taskId":created["id"]}),
        )
        .await
        .unwrap();
        assert_eq!(restored, updated);
        assert_eq!(
            dispatch(&reopened, &owner, "areal/task/update", request)
                .await
                .unwrap(),
            updated
        );
        reopened.shutdown().await;
    }

    fn validate(group: &str, method: &str, value: &Value) {
        let schemas: Value =
            serde_json::from_str(include_str!("../../../schemas/areal-core-v1.json")).unwrap();
        let validator = jsonschema::validator_for(&schemas[group][method]).unwrap();
        let errors: Vec<_> = validator
            .iter_errors(value)
            .map(|e| e.to_string())
            .collect();
        assert!(errors.is_empty(), "{method}: {errors:?}\n{value}");
    }

    #[tokio::test]
    async fn task_contracts_filter_authorization_and_subscriptions_independently_of_threads() {
        let dir = tempfile::tempdir().unwrap();
        let model =
            areal_engine::model::ChatModel::new("http://127.0.0.1:9".into(), "unused".into(), None)
                .unwrap();
        let engine =
            Engine::open(dir.path(), Arc::new(model), areal_engine::Limits::default()).unwrap();
        let first = engine.create(engine.default_cwd()).await.unwrap();
        let second = engine.create(engine.default_cwd()).await.unwrap();
        let owner = auth::Principal::embedded();
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 86400;
        let mut ids = Vec::new();
        for (n, thread) in [&first, &second].into_iter().enumerate() {
            let params = json!({"requestId":format!("scheduled-{n}"),"mode":"scheduled","objective":"Inspect workspace","threadId":thread.id,"schedule":{"at":at}});
            validate("requests", "areal/task/create", &params);
            let value = dispatch(&engine, &owner, "areal/task/create", params)
                .await
                .unwrap();
            validate("responses", "areal/task/create", &value);
            ids.push(value["id"].as_str().unwrap().to_owned());
        }
        let principal = Arc::new(auth::Principal {
            thread_ids: Some([first.id.clone()].into()),
            ..(*owner).clone()
        });
        let listed = dispatch(&engine, &principal, "areal/task/list", json!({"limit":1}))
            .await
            .unwrap();
        validate("responses", "areal/task/list", &listed);
        assert_eq!(listed["data"].as_array().unwrap().len(), 1);
        assert_eq!(listed["data"][0]["id"], ids[0]);
        assert!(listed["nextCursor"].is_null());
        assert_eq!(
            dispatch(
                &engine,
                &principal,
                "areal/task/read",
                json!({"taskId":ids[1]})
            )
            .await
            .unwrap_err()
            .code,
            -32003
        );
        assert_eq!(
            dispatch(
                &engine,
                &principal,
                "areal/task/create",
                json!({"requestId":"unbound","mode":"background","objective":"not authorized"})
            )
            .await
            .unwrap_err()
            .code,
            -32003
        );
        assert_eq!(
            auth::permission("areal/channel/reply"),
            auth::Permission::Interact
        );
        assert_eq!(
            auth::permission("areal/task/subscribe"),
            auth::Permission::Observe
        );
        let (tx, mut rx) = mpsc::channel(32);
        let stop = CancellationToken::new();
        let mut conn = Connection {
            configuration: None,
            experimental_api: false,
            principal,
            tool_host: dynamic_tools::ToolHost::new(tx.clone(), stop.clone()),
            initialized: true,
            ready: true,
            subscriptions: HashMap::new(),
            suppressed: HashSet::new(),
            tx,
            stop: stop.clone(),
            tasks: TaskTracker::new(),
            delivery: Arc::new(Mutex::new(())),
            rpc_permits: Arc::new(tokio::sync::Semaphore::new(16)),
        };
        assert_eq!(
            conn.dispatch(&engine, "areal/task/subscribe", json!({"taskId":ids[1]}))
                .await
                .unwrap_err()
                .code,
            -32003
        );
        let snapshot = conn
            .dispatch(&engine, "areal/task/subscribe", json!({"taskId":ids[0]}))
            .await
            .unwrap();
        validate("responses", "areal/task/subscribe", &snapshot);
        for id in ids.iter().rev() {
            let task = engine.task_read(id).await.unwrap();
            let params = json!({"requestId":format!("pause-{id}"),"taskId":id,"expectedRevision":task.revision});
            validate("requests", "areal/task/pause", &params);
            let value = dispatch(&engine, &owner, "areal/task/pause", params)
                .await
                .unwrap();
            validate("responses", "areal/task/pause", &value);
        }
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let Outbound::Event { value: event, .. } = event else {
            panic!("subscription must deliver an event");
        };
        assert_eq!(event["params"]["taskId"], ids[0]);
        validate("notifications", "areal/task/updated", &event["params"]);
        let page = conn
            .dispatch(&engine, "areal/channel/read", json!({"taskId":ids[0]}))
            .await
            .unwrap();
        validate("responses", "areal/channel/read", &page);
        let inbox = conn
            .dispatch(&engine, "areal/inbox/list", json!({}))
            .await
            .unwrap();
        validate("responses", "areal/inbox/list", &inbox);
        let removed = conn
            .dispatch(&engine, "areal/task/unsubscribe", json!({"taskId":ids[0]}))
            .await
            .unwrap();
        validate("responses", "areal/task/unsubscribe", &removed);
        assert!(conn.subscriptions.is_empty());
        let task = engine.task_read(&ids[0]).await.unwrap();
        let result = engine
            .task_control(
                owner.id.clone(),
                "cancel".into(),
                TaskControl {
                    expected_run_id: None,
                    request_id: "cancel".into(),
                    task_id: ids[0].clone(),
                    expected_revision: task.revision,
                },
            )
            .await
            .unwrap();
        validate("responses", "areal/task/cancel", &result);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), rx.recv())
                .await
                .is_err()
        );
        stop.cancel();
        conn.tasks.close();
        conn.tasks.wait().await;
        engine.shutdown().await;
    }
}

#[cfg(test)]
mod manual_tests;

#[cfg(test)]
mod calendar_tests;

#[cfg(test)]
mod calendar_dispatch_tests;
