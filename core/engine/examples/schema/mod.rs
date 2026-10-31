//! 桌面扩展投影的响应和事件；动态工具参数、Runtime capabilities 保留扩展对象。
use areal_protocol::{desktop::*, *};
use serde_json::{Value, json};
pub mod plugins;
pub(super) mod standalone;
fn schema<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap()
}
fn object(properties: Value) -> Value {
    let keys: Vec<_> = properties.as_object().unwrap().keys().cloned().collect();
    json!({"type":"object","properties":properties,"required":keys,"additionalProperties":true})
}
fn array(items: Value) -> Value {
    json!({"type":"array","items":items})
}
fn nullable(value: Value) -> Value {
    json!({"anyOf":[value,{"type":"null"}]})
}
fn data(items: Value) -> Value {
    object(json!({"data":array(items)}))
}
pub fn projections() -> (Value, Value) {
    let string = json!({"type":"string"});
    let number = json!({"type":"integer","minimum":0});
    let boolean = json!({"type":"boolean"});
    let any_object = json!({"type":"object"});
    let turn = schema::<Turn>();
    let thread = schema::<Thread>();
    let mut deferred = schema::<DeferredHistoryItem>();
    deferred["properties"]["type"] = json!({"const":"historyDeferred"});
    let display_item = json!({"anyOf":[schema::<Item>(),deferred.clone()]});
    let mut display_thread = thread.clone();
    let ordinary_item = display_thread["$defs"]["Item"].take();
    display_thread["$defs"]["Item"] = json!({"anyOf":[ordinary_item,deferred]});
    let history_window = object(
        json!({"snapshotId":string,"nextCursor":nullable(string.clone()),"complete":boolean}),
    );
    let provider = schema::<Provider>();
    let profile = schema::<AgentProfile>();
    let config = schema::<EffectiveConfig>();
    let queue = schema::<Queue>();
    let interaction = schema::<Interaction>();
    let process = schema::<ManagedProcess>();
    let mut provider_view = provider.clone();
    provider_view["properties"]["credentialState"] =
        json!({"enum":["notRequired","available","unavailable"]});
    provider_view["properties"]["connectionState"] = json!({"const":"unchecked"});
    let receipt = object(json!({
        "identity":string,"requestId":string,"method":string,"digest":string,
        "operation":schema::<OperationRef>(),"status":{"enum":["admitted","completed","failed","unconfirmed"]}
    }));
    let process_target = object(json!({"id":string,"runtimeEpoch":string}));
    let accepted = object(json!({"accepted":boolean,"operationId":string}));
    let group_entry = object(
        json!({"id":string,"owner":string,"status":string,"revision":number,"objective":string,"peakWorkers":number,"head":string,"cleanupConfirmed":nullable(boolean.clone()),"cleanupError":nullable(string.clone())}),
    );
    let mut record = schema::<areal_engine::workgroup::Record>();
    for name in ["history", "verifications"] {
        record["properties"].as_object_mut().unwrap().remove(name);
        record["required"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v != name);
    }
    let mut group = object(
        json!({"id":string,"record":record,"historyCount":number,"verificationCount":number,"recordPath":string,"candidatePath":string}),
    );
    group["properties"]["elapsedMs"] = nullable(number.clone());
    let mcp = object(
        json!({"id":string,"revision":number,"directoryRevision":number,"config":schema::<areal_mcp::ServerConfig>(),"state":{"enum":["disconnected","connecting","connected","failed","stale","cleanupFailed"]},"error":nullable(string.clone()),"tools":nullable(array(schema::<ToolDefinition>()))}),
    );
    let resource = json!({"anyOf":[
        object(json!({"threadId":string,"id":string,"state":string,"epoch":string})),
        object(json!({"kind":{"const":"runtime"},"state":string,"epoch":string})),
        object(json!({"kind":{"const":"hookTaskScope"},"threadId":string,
            "state":{"const":"cleanupUnknown"},"operationId":nullable(string.clone()),
            "scopeId":nullable(string.clone())}))
    ]});
    let lifecycle_assessment = object(json!({
        "allowed":boolean,
        "reasons":array(object(json!({
            "code":{"enum":["activeTurn","resource","compaction","workgroup","activeGoal","queuedMessage","activeTask"]},
            "count":number
        })))
    }));
    let lifecycle = object(json!({
        "version":{"const":1},
        "admission":{"enum":["open","draining","closed"]},
        "ifIdle":lifecycle_assessment,
        "settled":lifecycle_assessment,
        "executionOutcomes":object(json!({"uninspectedUnknown":number}))
    }));
    let status = object(
        json!({"configuration":nullable(object(json!({"modelRevision":string,"restartRequired":boolean,"error":nullable(string.clone())}))),"apiVersion":{"const":API_VERSION},"stateVersion":number,"productVersion":string,"draining":boolean,"closed":boolean,"acceptingWork":boolean,"activeTasks":number,"activeGoals":array(string.clone()),"pendingQueueItems":number,"activeTurns":array(object(json!({"threadId":string,"turnId":string}))),"resources":array(resource),"unresolvedTools":array(object(json!({"threadId":string,"itemId":string}))),"compactions":array(string.clone()),"workgroups":array(group_entry.clone()),"runtime":nullable(any_object.clone()),"capacity":object(json!({"threads":number,"maxThreads":number,"activeTurns":number,"maxActiveTurns":number,"historyBytesPerThread":number,"blobBytes":number})),"restartSafe":boolean,"lifecycle":lifecycle,"idleForMs":number}),
    );
    let context_budget = object(
        json!({"windowTokens":number,"outputReserveTokens":number,"inputLimitTokens":number,"targetTokens":number,"windowSource":{"enum":["model","fallback"]},"outputLimitTokens":nullable(number.clone()),"historyEstimatedTokens":number,"estimatedInputTokens":number,"estimateScope":{"const":"historyWithRecordedInstructionsAndCurrentTools"},"retentionStrategy":{"enum":["automatic","legacyRecentBoundary"]}}),
    );
    let context = object(
        json!({"budget":nullable(context_budget),"threadId":string,"view":{"const":"historyProjectionForNextRequest"},"systemInstructionsIncluded":boolean,"instructionSnapshot":nullable(string.clone()),"checkpoint":nullable(schema::<ContextCheckpoint>()),"offset":number,"nextOffset":nullable(number.clone()),"data":array(object(json!({"role":string,"text":string,"toolCalls":array(any_object.clone()),"toolCallId":nullable(string.clone()),"opaqueProviderContextOmitted":boolean,"media":array(string.clone())})))}),
    );
    let mut responses = serde_json::Map::new();
    let mut insert = |names: &[&str], value: Value| {
        for name in names {
            responses.insert(format!("areal/{name}"), value.clone());
        }
    };
    insert(
        &["work/overview"],
        schema::<areal_protocol::work::OverviewPage>(),
    );
    insert(
        &["task/schedule/context"],
        schema::<areal_protocol::tasks::ScheduleContext>(),
    );
    insert(
        &["task/schedule/preview"],
        schema::<areal_protocol::tasks::SchedulePreviewed>(),
    );
    let mut task_view = schema::<areal_protocol::tasks::Task>();
    task_view["properties"]
        .as_object_mut()
        .unwrap()
        .remove("messages");
    task_view["required"]
        .as_array_mut()
        .unwrap()
        .retain(|v| v != "messages");
    for name in ["runCount", "archivedRunCount", "runsComplete"] {
        task_view["required"]
            .as_array_mut()
            .unwrap()
            .push(json!(name));
    }
    task_view["properties"]["pendingQuestions"] = number.clone();
    task_view["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("pendingQuestions"));
    let task_event = object(
        json!({"taskId":string,"revision":number,"channelSequence":number,"runId":nullable(string.clone()),"task":task_view}),
    );
    insert(
        &[
            "task/create",
            "task/update",
            "task/read",
            "task/subscribe",
            "task/pause",
            "task/resume",
            "task/cancel",
            "task/delete",
            "task/stopRun",
            "task/resumeRun",
        ],
        task_view.clone(),
    );
    let mut run_now = schema::<areal_protocol::tasks::TaskRunNowAccepted>();
    run_now["properties"]["accepted"] = json!({"const":true});
    insert(&["task/runNow"], run_now.clone());
    let mut runs_page = schema::<areal_protocol::tasks::TaskRunsPage>();
    runs_page["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("nextCursor"));
    insert(&["task/runs/list"], runs_page);
    insert(
        &["task/run/read"],
        schema::<areal_protocol::tasks::TaskRun>(),
    );
    insert(
        &["task/directory/list"],
        schema::<areal_protocol::tasks::TaskDirectoryPage>(),
    );
    insert(
        &["task/directory/read"],
        schema::<areal_protocol::tasks::TaskDirectoryRows>(),
    );
    insert(
        &["task/attention/read"],
        schema::<areal_protocol::tasks::OwnerAttentionPage>(),
    );
    insert(
        &["owner/watch"],
        schema::<areal_protocol::tasks::OwnerWatch>(),
    );
    insert(&["owner/unwatch"], object(json!({"removed":boolean})));
    insert(&["task/host/ready"], object(json!({"ready":boolean})));
    insert(&["task/unsubscribe"], object(json!({"removed":boolean})));
    insert(
        &["task/list"],
        object(json!({"data":array(task_view),"nextCursor":nullable(string.clone())})),
    );
    insert(
        &["inbox/list"],
        object(
            json!({"data":array(object(json!({"taskId":string,"objective":string,"message":schema::<areal_protocol::tasks::ChannelMessage>()}))),"nextCursor":nullable(string.clone())}),
        ),
    );
    insert(
        &["channel/read"],
        object(
            json!({"taskId":string,"channelSequence":number,"data":array(schema::<areal_protocol::tasks::ChannelMessage>()),"nextSequence":number,"hasMore":boolean}),
        ),
    );
    insert(
        &["channel/reply"],
        object(
            json!({"accepted":boolean,"messageId":string,"taskId":string,"runId":string,"channelSequence":number}),
        ),
    );
    let goal_view = object(
        json!({"threadId":string,"revision":number,"eventSequence":number,"goal":nullable(schema::<areal_protocol::goals::Goal>())}),
    );
    insert(
        &[
            "goal/get",
            "goal/update",
            "goal/pause",
            "goal/resume",
            "goal/clear",
        ],
        goal_view.clone(),
    );
    insert(
        &["goal/create"],
        object(
            json!({"threadId":string,"revision":number,"eventSequence":number,"goal":schema::<areal_protocol::goals::Goal>(),"turnId":string,"taskId":string,"runId":string}),
        ),
    );
    insert(
        &["capabilities"],
        object(
            json!({"apiVersion":{"const":API_VERSION},"methods":array(string.clone()),"methodSemantics":{"type":"object","additionalProperties":schema::<MethodSemantics>()},"notifications":array(string.clone()),"serverRequests":array(string.clone()),"features":{"type":"object","properties":{"threadCreationJournal":object(json!({"version":{"const":1},"binding":schema::<CreationAdmission>()})),"mcpPageToolsV1":object(json!({"version":{"const":1},"kinds":array(json!({"enum":["getSelection","applyPatch"]}))})),"conversationDerivationV1":nullable(object(json!({"preview":{"const":false},"methods":array(string.clone()),"forkBoundaries":array(json!({"enum":["before","after"]})),"workspaceModes":array(json!({"const":"sharedCurrent"})),"sideWorkspaceAccess":array(json!({"enum":["none","readOnly"]})),"historyBytes":number.clone(),"limits":object(json!({"maxThreads":number.clone(),"maxActiveTurns":number.clone(),"maxSideTurnsPerSource":number.clone(),"maxSideTurnsPerDeployment":number.clone(),"maxSideModelRounds":number.clone(),"maxSideToolCalls":number.clone(),"maxSideTurnSeconds":number.clone()}))})))},"additionalProperties":{"type":"boolean"}},"limits":object(json!({"frameBytes":number,"subscriptions":number,"sendQueue":number,"threadEventWindow":number})),"runtime":nullable(any_object.clone())}),
        ),
    );
    insert(
        &["subscription/remove"],
        object(json!({"subscriptionCount":number})),
    );
    insert(&["thread/start"], object(json!({"thread":thread})));
    let mut observation =
        object(json!({"thread":display_thread,"ownership":schema::<ThreadOwnership>()}));
    observation["properties"]["history"] = history_window.clone();
    insert(&["thread/observe"], observation);
    insert(&["thread/configure"], config.clone());
    insert(&["thread/prediction"], schema::<Option<PromptPrediction>>());
    insert(
        &["thread/inspect"],
        object(
            json!({"threadId":string,"sessionId":string,"parentThreadId":nullable(string.clone()),"activeTurnId":nullable(string.clone()),"configuration":config,"instructionSnapshot":nullable(string.clone()),"instructionSources":array(string.clone()),"tools":array(any_object.clone()),"loadedSkills":nullable(json!({"type":"object","additionalProperties":{"type":"string"}})) ,"contextCheckpoint":nullable(schema::<ContextCheckpoint>()),"usage":nullable(schema::<ModelUsage>()),"usageKnown":boolean,"limits":object(json!({"historyBytes":number,"contextBytes":number})),"runtime":nullable(any_object.clone())}),
        ),
    );
    insert(
        &["thread/archive"],
        object(
            json!({"threadId":string,"archived":boolean,"history":string,"receiptsRetained":boolean}),
        ),
    );
    insert(
        &["thread/closeResources"],
        object(json!({"cleanupConfirmed":boolean})),
    );
    insert(&["turn/start"], object(json!({"turn":turn})));
    insert(
        &["turn/enqueue"],
        object(json!({"queueItemId":string,"queueRevision":number,"configRevision":number})),
    );
    insert(&["profile/list"], data(profile.clone()));
    insert(&["profile/read"], profile);
    insert(&["provider/list"], data(provider_view.clone()));
    insert(&["provider/read"], provider_view);
    insert(&["provider/upsert"], provider);
    insert(&["provider/remove"], object(json!({})));
    insert(
        &["provider/probe"],
        json!({"oneOf":[object(json!({"providerId":string,"providerRevision":number,"modelId":string,"state":{"const":"connected"},"checked":array(string.clone()),"evidence":object(json!({"textReceived":boolean,"usage":nullable(schema::<ModelUsage>())}))})),object(json!({"providerId":string,"providerRevision":number,"modelId":string,"state":{"const":"failed"},"checked":array(string.clone()),"error":string}))]}),
    );
    insert(
        &["model/list"],
        data(object(
            json!({"providerId":nullable(string.clone()),"modelId":string,"providerRevision":nullable(number.clone()),"input":array(schema::<Modality>()),"output":array(schema::<Modality>())}),
        )),
    );
    insert(&["plan/read", "plan/update"], schema::<Plan>());
    insert(
        &[
            "queue/list",
            "queue/update",
            "queue/remove",
            "queue/reorder",
            "queue/pause",
            "queue/resume",
        ],
        queue.clone(),
    );
    insert(
        &["queue/steer"],
        object(
            json!({"queueRevision":number,"queueItemId":string,"turnId":string,"itemId":string}),
        ),
    );
    insert(
        &["interaction/list"],
        object(json!({"revision":number,"data":array(interaction.clone())})),
    );
    insert(
        &["interaction/respond"],
        json!({"oneOf":[object(json!({"answers":{"type":"object","additionalProperties":{"type":"string"}}})),object(json!({"decision":{"enum":["allowOnce","allowSession","allowProject","deny"]},"argumentsDigest":string}))]}),
    );
    insert(
        &["permissions/read"],
        object(json!({
            "configuration":object(json!({"mode":{"enum":["YOLO","ASK_PERMISSIONS"]},"allow":array(string.clone()),"ask":array(string.clone()),"deny":array(string.clone())})),
            "source":nullable(any_object.clone()),"sandbox":any_object,"workspace":string,
            "session":nullable(array(schema::<PermissionGrant>())),"project":array(schema::<PermissionGrant>()),"projectFile":string
        })),
    );
    insert(&["permissions/forget"], object(json!({"cleared":boolean})));
    insert(&["process/start"], process_target);
    insert(&["process/list"], data(process.clone()));
    insert(
        &["process/get"],
        object(
            json!({"process":process,"runtime":nullable(schema::<areal_runtime_protocol::ProcessInfo>())}),
        ),
    );
    insert(
        &["process/read"],
        schema::<areal_runtime_protocol::OutputPage>(),
    );
    insert(
        &["process/wait"],
        json!({"oneOf":[object(json!({"timedOut":{"const":true}})),object(json!({"timedOut":{"const":false},"runtime":schema::<areal_runtime_protocol::ProcessInfo>()}))]}),
    );
    insert(
        &[
            "process/write",
            "process/resize",
            "process/closeStdin",
            "process/terminate",
        ],
        accepted,
    );
    insert(
        &["process/acknowledgeCleanup"],
        object(
            json!({"cleanupConfirmed":boolean,"source":{"const":"operatorAttestation"},"executionOutcomeUnchanged":boolean}),
        ),
    );
    insert(
        &["mcp/list", "mcp/configure", "mcp/connect", "mcp/disconnect"],
        data(mcp.clone()),
    );
    insert(&["mcp/read"], mcp);
    insert(&["server/status", "server/drain"], status);
    let model_configuration_proof = object(json!({
        "serviceId":string,"generation":string,"applied":schema::<AppliedModelConfiguration>(),
        "modelRevision":string,"credentialStates":{"type":"object","additionalProperties":{"enum":["notRequired","available","unavailable"]}}
    }));
    let mut model_configuration = model_configuration_proof.clone();
    model_configuration["properties"]["operation"] = object(json!({
        "requestId":string,"state":{"enum":["running","applied","rejected","unknown"]}
    }));
    model_configuration["properties"]["operation"]["properties"]["result"] =
        model_configuration_proof;
    model_configuration["properties"]["operation"]["properties"]["error"] = schema::<RpcError>();
    insert(
        &[
            "server/modelConfiguration/read",
            "server/modelConfiguration/apply",
        ],
        model_configuration,
    );
    insert(
        &["server/gc"],
        object(json!({"deletedBlobs":number,"reclaimedBytes":number,"retainedBytes":number})),
    );
    insert(&["blob/release"], object(json!({"released":boolean})));
    insert(&["context/read", "context/compact"], context);
    insert(
        &["skill/list"],
        object(
            json!({"data":array(object(json!({"id":string,"revision":string,"available":boolean,"name":string,"description":string,"resources":{"type":"null"},"resourceRoot":nullable(string.clone())}))),"loaded":nullable(json!({"type":"object","additionalProperties":{"type":"string"}}))}),
        ),
    );
    insert(
        &["skill/read"],
        object(
            json!({"id":string,"revision":string,"resource":string,"sizeBytes":number,"dataBase64":string,"text":nullable(string.clone()),"nextOffset":number,"eof":boolean}),
        ),
    );
    insert(
        &["workflow/list"],
        data(schema::<areal_engine::desktop::Workflow>()),
    );
    insert(
        &["workflow/read"],
        schema::<areal_engine::desktop::Workflow>(),
    );
    insert(
        &[
            "workflow/start",
            "workgroup/start",
            "workgroup/read",
            "workgroup/wait",
            "workgroup/cancel",
            "workgroup/revise",
        ],
        group,
    );
    insert(
        &["workgroup/policy"],
        schema::<areal_engine::workgroup::service::Policy>(),
    );
    insert(&["workgroup/list"], data(group_entry));
    insert(
        &["workgroup/artifact", "execution/artifact"],
        json!({"oneOf":[object(json!({"head":string,"paths":array(string.clone()),"nextOffset":number,"complete":boolean})),object(json!({"head":string,"path":string,"exists":boolean,"baseSha256":nullable(string.clone()),"sha256":nullable(string.clone()),"executable":nullable(boolean.clone()),"bytes":number,"offset":number,"nextOffset":number,"complete":boolean,"dataBase64":string,"text":nullable(string.clone())}))]}),
    );
    let mut execution = object(json!({
        "executionId":string,"parentThreadId":string,"title":string,"status":string,
        "settled":boolean,"resourcesReleased":boolean,"text":string,"error":nullable(string.clone()),
        "verification":object(json!({"status":{"enum":["notRun","passed","failed"]},"kind":{"enum":["none","project","trusted"]}})),
        "delivery":object(json!({"status":{"enum":["notRequired","pending","candidate","preparing","applying","applied","conflict","partial","unknown","failed","requiresActiveTurn","cancelled"]}}))
    }));
    execution["properties"]["verification"]["properties"]["head"] = string.clone();
    // 后端句柄与选择原因仅用于可选诊断，不成为调用方判断完成的依据。
    for (name, value) in [
        ("threadId", string.clone()),
        ("turnId", string.clone()),
        ("strategy", string.clone()),
        ("reason", string.clone()),
        ("offset", number.clone()),
        ("nextOffset", nullable(number.clone())),
        ("textBytes", number.clone()),
        ("durationMs", nullable(number.clone())),
        ("startedAtMs", nullable(number.clone())),
        ("elapsedMs", nullable(number.clone())),
        ("requestId", string.clone()),
        ("source", string.clone()),
        ("sourceItemId", string.clone()),
        ("stopRequested", boolean.clone()),
        (
            "owner",
            schema::<areal_protocol::delegation::ExecutionOwner>(),
        ),
        (
            "artifact",
            object(json!({"head":string,"workgroupId":string})),
        ),
    ] {
        execution["properties"][name] = value;
    }
    insert(
        &[
            "agent/delegate",
            "execution/read",
            "execution/cancel",
            "execution/apply",
        ],
        execution.clone(),
    );
    insert(
        &["execution/list"],
        object(json!({"data":array(execution.clone()),"nextOffset":nullable(number.clone())})),
    );
    insert(
        &["execution/traceResult"],
        object(json!({"bytes":array(number.clone())})),
    );
    insert(
        &["execution/trace"],
        object(json!({
            "threadId":string,"parentThreadId":nullable(string.clone()),"title":string,
            "page":object(json!({"snapshotId":nullable(string.clone()),"data":array(any_object.clone()),"nextCursor":nullable(string.clone()),"complete":boolean})),
            "activeTurn":nullable(turn.clone()),"sources":array(object(json!({"threadId":string,"title":string}))),"legacySources":array(object(json!({"threadId":string,"title":string}))),
            "executions":object(json!({"data":array(execution.clone()),"nextOffset":nullable(number.clone())})),
            "queue":nullable(queue.clone()),"readAtMs":number,"stateConfirmed":boolean
        })),
    );
    let mut execution_wait = execution;
    execution_wait["properties"]["timedOut"] = boolean.clone();
    execution_wait["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("timedOut"));
    insert(&["execution/wait"], execution_wait);
    insert(
        &["agent/list"],
        object(json!({"data":array(thread.clone()),"nextCursor":nullable(string.clone())})),
    );
    insert(
        &["agent/spawn"],
        json!({"oneOf":[object(json!({"thread":thread,"turn":turn,"threadId":string,"turnId":string,"configuration":nullable(any_object.clone())})),object(json!({"agentId":string,"workspaceMode":{"const":"isolatedWrite"},"workgroup":any_object}))]}),
    );
    insert(
        &["agent/wait"],
        data(
            json!({"oneOf":[object(json!({"threadId":string,"turnId":string,"status":schema::<TurnStatus>(),"error":nullable(schema::<TurnError>()),"text":string,"truncated":boolean,"configuration":nullable(any_object.clone())})),object(json!({"agentId":string,"workspaceMode":{"const":"isolatedWrite"},"result":any_object}))]}),
        ),
    );
    let mut request_receipts = object(
        json!({"data":array(receipt),"retention":{"enum":["threadLifetime","deploymentLifetime","threadAndDeploymentLifetime"]},"capacity":number}),
    );
    request_receipts["properties"]["creationAdmission"] = json!({"type":"object","additionalProperties":false,
        "required":["status","identity","requestId","method","journalEpoch","coreInstanceId"],
        "properties":{"status":{"enum":["admitted","unconfirmed","notAdmitted"]},"identity":string,"requestId":string,
            "method":{"const":"areal/thread/start"},"journalEpoch":{"type":"string","format":"uuid"},
            "coreInstanceId":{"type":"string","format":"uuid"}}});
    insert(
        &["request/read"],
        json!({"oneOf":[request_receipts,
            object(json!({"data":array(object(json!({"identity":string,"requestId":string,"method":{"const":"areal/task/runNow"},"digest":string,"result":run_now}))),"retention":{"const":"taskLifetime"}}))
        ]}),
    );
    insert(&["tool/acknowledge"], object(json!({})));
    insert(
        &["thread/fork"],
        object(json!({"thread":thread.clone(),"requestId":string.clone()})),
    );
    insert(
        &["side/start"],
        object(json!({"thread":thread.clone(),"turn":turn.clone(),"requestId":string.clone()})),
    );
    insert(
        &["side/create"],
        object(
            json!({"thread":thread.clone(),"turn":nullable(turn.clone()),"requestId":string.clone()}),
        ),
    );
    insert(
        &["side/close"],
        object(
            json!({"threadId":string.clone(),"requestId":string.clone(),"accepted":boolean.clone(),"cleanupConfirmed":boolean.clone()}),
        ),
    );
    insert(
        &["side/context/read"],
        object(json!({
            "snapshotId":string.clone(),
            "evidence":array(object(json!({
                "evidenceRef":string.clone(),"sourceTurnId":string.clone(),
                "sourceItemId":string.clone(),"sourceTurnStatus":schema::<TurnStatus>(),
                "text":string.clone(),
                "range":object(json!({"startUtf8":number.clone(),"endUtf8":number.clone(),"totalBytes":number.clone()}))
            }))),
            "nextCursor":nullable(string.clone()),"complete":boolean
        })),
    );
    let mut history_fragment = object(
        json!({"text":string,"offsetUtf8":number,"nextOffsetUtf8":number,"totalBytes":number}),
    );
    history_fragment["properties"]["version"] = string.clone();
    insert(
        &["conversation/history"],
        object(
            json!({"snapshotId":nullable(string.clone()),"data":array(json!({"oneOf":[
                object(json!({"sourceThreadId":string.clone(),"sourceTurnId":string.clone(),"sourceItemId":string.clone(),"sourceTurnStatus":schema::<TurnStatus>(),"item":display_item})),
                object(json!({"sourceThreadId":string.clone(),"sourceTurnId":string.clone(),"sourceItemId":string.clone(),"sourceTurnStatus":schema::<TurnStatus>(),"fragment":history_fragment}))
            ]})),"nextCursor":nullable(string.clone()),"complete":boolean}),
        ),
    );
    insert(
        &["conversation/list"],
        object(json!({"data":array(thread.clone()),"nextCursor":nullable(string.clone())})),
    );
    insert(
        &["conversation/unarchive"],
        object(json!({"threadId":string.clone(),"archived":boolean})),
    );
    insert(
        &["thread/tools/attach"],
        object(json!({"threadId":string,"toolsetRevision":number,"bundleId":string})),
    );
    responses.insert("thread/read".into(), object(json!({"thread":thread})));
    for name in ["thread/start", "thread/resume"] {
        responses.insert(name.into(),object(json!({"thread":thread,"cwd":string,"model":string,"modelProvider":string,"approvalPolicy":string,"permissionMode":{"enum":["YOLO","ASK_PERMISSIONS"]},"approvalsReviewer":string,"sandbox":any_object,"reasoningEffort":nullable(string.clone())})));
    }
    responses["thread/resume"]["properties"]["thread"] = display_thread;
    responses["thread/resume"]["properties"]["history"] = history_window;
    responses["thread/resume"]["properties"]["ownership"] = schema::<ThreadOwnership>();
    responses.insert(
        "thread/list".into(),
        object(json!({"data":array(thread.clone()),"nextCursor":nullable(string.clone())})),
    );
    responses.insert("turn/start".into(), object(json!({"turn":turn})));
    responses.insert("turn/steer".into(), object(json!({"turnId":string})));
    responses.insert("turn/interrupt".into(), object(json!({})));
    responses.insert(
        "initialize".into(),
        object(json!({"userAgent":string,"platformFamily":string,"platformOs":string})),
    );
    responses.insert("model/list".into(),object(json!({"data":array(object(json!({"id":string,"model":string,"displayName":string,"description":string,"hidden":boolean,"isDefault":boolean,"defaultReasoningEffort":string,"supportedReasoningEfforts":array(any_object.clone()),"inputModalities":array(string.clone()),"arealCapabilities":object(json!({"inputModalities":array(string.clone()),"outputModalities":array(string.clone())}))}))),"nextCursor":nullable(string.clone())})));
    let mut notifications = serde_json::Map::new();
    notifications.insert("areal/server/configurationChanged".into(), object(json!({"threadId":string,"configuration":object(json!({"modelRevision":string,"restartRequired":boolean,"error":nullable(string.clone())}))})));
    notifications.insert("areal/task/updated".into(), task_event);
    notifications.insert(
        "areal/owner/invalidated".into(),
        schema::<areal_protocol::tasks::OwnerInvalidation>(),
    );
    notifications.insert(
        "areal/owner/resetRequired".into(),
        object(json!({"generation":string})),
    );
    notifications.insert("areal/goal/updated".into(), goal_view);
    notifications.insert("areal/goal/cleared".into(),object(json!({"threadId":string,"revision":number,"eventSequence":number,"goal":nullable(schema::<areal_protocol::goals::Goal>()),"goalId":string})));
    notifications.insert("thread/started".into(), object(json!({"thread":thread})));
    notifications.insert(
        "areal/thread/edited".into(),
        object(json!({"threadId":string,"thread":thread})),
    );
    notifications.insert(
        "areal/thread/predictionChanged".into(),
        object(json!({"threadId":string,"promptPrediction":schema::<PromptPrediction>()})),
    );
    for name in ["turn/started", "turn/completed"] {
        notifications.insert(name.into(), object(json!({"threadId":string,"turn":turn})));
    }
    for name in [
        "item/started",
        "item/completed",
        "areal/item/agentMedia/available",
    ] {
        notifications.insert(
            name.into(),
            object(json!({"threadId":string,"turnId":string,"item":schema::<Item>()})),
        );
    }
    notifications.insert(
        "item/agentMessage/delta".into(),
        object(json!({"threadId":string,"turnId":string,"itemId":string,"delta":string})),
    );
    notifications.insert(
        "item/reasoning/textDelta".into(),
        object(json!({"threadId":string,"turnId":string,"itemId":string,"contentIndex":{"type":"integer","minimum":0},"delta":string})),
    );
    notifications.insert(
        "item/reasoning/summaryTextDelta".into(),
        object(json!({"threadId":string,"turnId":string,"itemId":string,"summaryIndex":{"type":"integer","minimum":0},"delta":string})),
    );
    notifications.insert("areal/context/compactionFailed".into(), object(json!({"threadId":string,"code":{"const":"LLM_CONTEXT_COMPACTION_FAILED"},"reason":string,"checkpointPreserved":boolean,"windowTokens":number,"outputReserveTokens":number,"inputLimitTokens":number,"beforeEstimatedTokens":number})));
    notifications.insert("areal/context/compacted".into(),object(json!({"threadId":string,"beforeBytes":number,"afterBytes":number,"durationMs":number,"usage":nullable(schema::<ModelUsage>())})));
    notifications.insert(
        "areal/model/completionDiscarded".into(),
        object(json!({"threadId":string,"itemIds":array(string.clone()),"retry":{"type":"integer","minimum":1},"retryKind":{"enum":["network","completion","goalReport"]}})),
    );
    notifications.insert(
        "areal/model/watchdogRetry".into(),
        object(json!({"threadId":string,"turnId":nullable(string.clone()),"purpose":{"enum":["solve","summary"]},"retry":{"type":"integer","minimum":1},"delayMs":number})),
    );
    notifications.insert(
        "areal/tool/cancelled".into(),
        object(json!({"requestId":{"type":["string","integer"]}})),
    );

    for (name, value) in [
        (
            "areal/thread/configured",
            object(json!({"threadId":string,"configuration":config})),
        ),
        (
            "areal/thread/tools/attached",
            object(
                json!({"threadId":string,"toolsetRevision":number,"dynamicTools":array(schema::<ToolDefinition>())}),
            ),
        ),
        (
            "areal/side/capacity",
            object(json!({"threadId":string,"status":{"enum":["waiting","available"]}})),
        ),
        ("areal/thread/archived", object(json!({"threadId":string}))),
        (
            "areal/thread/unarchived",
            object(json!({"threadId":string})),
        ),
        (
            "areal/plan/updated",
            object(json!({"threadId":string,"plan":schema::<Plan>()})),
        ),
        (
            "areal/queue/updated",
            object(json!({"threadId":string,"queue":queue})),
        ),
        (
            "areal/interaction/requested",
            object(json!({"revision":number,"interaction":interaction})),
        ),
        (
            "areal/interaction/resolved",
            object(json!({"revision":number,"interaction":interaction})),
        ),
        (
            "areal/process/updated",
            object(json!({"threadId":string,"process":process})),
        ),
        (
            "areal/server/draining",
            object(json!({"threadId":string,"strategy":{"enum":["wait","cancel","ifIdle"]}})),
        ),
        (
            "areal/agent/spawned",
            object(json!({"parentThreadId":string,"threadId":string,"turnId":string})),
        ),
    ] {
        notifications.insert(name.into(), value);
    }
    plugins::projections(&mut responses, &mut notifications);
    (Value::Object(responses), Value::Object(notifications))
}

// Core 发送的调用与 broker 回执拥有独立方向，不接受 Host 提供授权归属。
pub fn native_messages() -> Value {
    let string = json!({"type":"string"});
    let call = object(
        json!({"type":{"const":"call"},"callId":string,"params":object(json!({"threadId":string,"turnId":string,"tool":string,"arguments":{}}))}),
    );
    let mut reply = object(
        json!({"type":{"enum":["fileResult","processResult"]},"callId":string,"requestId":{"type":"integer","minimum":0}}),
    );
    reply["properties"]["result"] = json!({});
    reply["properties"]["error"] = schema::<areal_runtime_protocol::Error>();
    reply["oneOf"] = json!([{"required":["result"],"not":{"required":["error"]}},{"required":["error"],"not":{"required":["result"]}}]);
    json!({"oneOf":[call,reply]})
}

#[cfg(test)]
mod tests;
