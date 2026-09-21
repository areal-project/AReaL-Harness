//! 桌面扩展投影的响应和事件；动态工具参数、Runtime capabilities 保留扩展对象。
use areal_protocol::{desktop::*, *};
use serde_json::{Value, json};
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
    let mut receipt = schema::<RequestReceipt>();
    receipt["additionalProperties"] = json!(true);
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
    let group = object(
        json!({"id":string,"record":record,"historyCount":number,"verificationCount":number,"recordPath":string,"candidatePath":string}),
    );
    let mcp = object(
        json!({"id":string,"revision":number,"directoryRevision":number,"config":schema::<areal_mcp::ServerConfig>(),"state":{"enum":["disconnected","connecting","connected","failed","stale","cleanupFailed"]},"error":nullable(string.clone()),"tools":nullable(array(schema::<ToolDefinition>()))}),
    );
    let status = object(
        json!({"apiVersion":{"const":API_VERSION},"stateVersion":number,"productVersion":string,"draining":boolean,"closed":boolean,"acceptingWork":boolean,"activeTurns":array(object(json!({"threadId":string,"turnId":string}))),"resources":array(object(json!({"threadId":string,"id":string,"state":string,"epoch":string}))),"unresolvedTools":array(object(json!({"threadId":string,"itemId":string}))),"compactions":array(string.clone()),"workgroups":array(group_entry.clone()),"runtime":nullable(any_object.clone()),"capacity":object(json!({"threads":number,"maxThreads":number,"activeTurns":number,"maxActiveTurns":number,"historyBytesPerThread":number,"blobBytes":number})),"restartSafe":boolean}),
    );
    let context = object(
        json!({"threadId":string,"view":{"const":"historyProjectionForNextRequest"},"systemInstructionsIncluded":boolean,"instructionSnapshot":nullable(string.clone()),"checkpoint":nullable(schema::<ContextCheckpoint>()),"offset":number,"nextOffset":nullable(number.clone()),"data":array(object(json!({"role":string,"text":string,"toolCalls":array(any_object.clone()),"toolCallId":nullable(string.clone()),"opaqueProviderContextOmitted":boolean,"media":array(string.clone())})))}),
    );
    let mut responses = serde_json::Map::new();
    let mut insert = |names: &[&str], value: Value| {
        for name in names {
            responses.insert(format!("areal/{name}"), value.clone());
        }
    };
    insert(
        &["capabilities"],
        object(
            json!({"apiVersion":{"const":API_VERSION},"methods":array(string.clone()),"notifications":array(string.clone()),"serverRequests":array(string.clone()),"features":{"type":"object","additionalProperties":{"type":"boolean"}},"limits":object(json!({"frameBytes":number,"subscriptions":number,"sendQueue":number,"threadEventWindow":number})),"runtime":nullable(any_object.clone())}),
        ),
    );
    insert(
        &["subscription/remove"],
        object(json!({"subscriptionCount":number})),
    );
    insert(&["thread/start"], object(json!({"thread":thread})));
    insert(&["thread/configure"], config.clone());
    insert(
        &["thread/inspect"],
        object(
            json!({"threadId":string,"sessionId":string,"parentThreadId":nullable(string.clone()),"activeTurnId":nullable(string.clone()),"configuration":config,"instructionSnapshot":nullable(string.clone()),"instructionSources":array(string.clone()),"tools":array(any_object.clone()),"loadedSkills":nullable(json!({"type":"object","additionalProperties":{"type":"string"}})) ,"contextCheckpoint":nullable(schema::<ContextCheckpoint>()),"usage":nullable(schema::<ModelUsage>()),"usageKnown":boolean,"limits":object(json!({"turnTimeoutMs":number,"historyBytes":number,"contextBytes":number})),"runtime":nullable(any_object.clone())}),
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
        &["interaction/list"],
        object(json!({"revision":number,"data":array(interaction.clone())})),
    );
    insert(
        &["interaction/respond"],
        json!({"oneOf":[object(json!({"answers":{"type":"object","additionalProperties":{"type":"string"}}})),object(json!({"decision":{"enum":["allowOnce","deny"]},"argumentsDigest":string}))]}),
    );
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
        &["workgroup/artifact"],
        json!({"oneOf":[object(json!({"head":string,"paths":array(string.clone()),"nextOffset":number,"complete":boolean})),object(json!({"head":string,"path":string,"exists":boolean,"baseSha256":nullable(string.clone()),"sha256":nullable(string.clone()),"executable":nullable(boolean.clone()),"bytes":number,"offset":number,"nextOffset":number,"complete":boolean,"dataBase64":string,"text":nullable(string.clone())}))]}),
    );
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
    insert(
        &["request/read"],
        object(
            json!({"data":array(json!({"oneOf":[receipt,object(json!({"identity":string,"requestId":string,"method":string,"digest":string,"state":{"enum":["accepted","completed","unknown"]},"response":{}}))]})),"retention":{"enum":["threadLifetime","deploymentLifetime"]},"capacity":number}),
        ),
    );
    insert(&["tool/acknowledge"], object(json!({})));
    responses.insert("thread/read".into(), object(json!({"thread":thread})));
    for name in ["thread/start", "thread/resume"] {
        responses.insert(name.into(),object(json!({"thread":thread,"cwd":string,"model":string,"modelProvider":string,"approvalPolicy":string,"approvalsReviewer":string,"sandbox":any_object,"reasoningEffort":nullable(string.clone())})));
    }
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
    notifications.insert("thread/started".into(), object(json!({"thread":thread})));
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
    notifications.insert("areal/context/compacted".into(),object(json!({"threadId":string,"beforeBytes":number,"afterBytes":number,"durationMs":number,"usage":nullable(schema::<ModelUsage>())})));
    notifications.insert(
        "areal/tool/cancelled".into(),
        object(json!({"requestId":{"type":["string","integer"]}})),
    );

    for (name, value) in [
        (
            "areal/thread/configured",
            object(json!({"threadId":string,"configuration":config})),
        ),
        ("areal/thread/archived", object(json!({"threadId":string}))),
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
            object(json!({"threadId":string,"strategy":{"enum":["wait","cancel"]}})),
        ),
        (
            "areal/agent/spawned",
            object(json!({"parentThreadId":string,"threadId":string,"turnId":string})),
        ),
    ] {
        notifications.insert(name.into(), value);
    }
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
