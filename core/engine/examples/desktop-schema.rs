mod schema;
use areal_protocol::desktop::*;
use serde_json::{Value, json};
fn main() {
    let output = if std::env::args().any(|arg| arg == "--native-host") {
        native_host_schema()
    } else {
        desktop_schema()
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
fn native_host_schema() -> Value {
    let mut output = json!({"protocolVersion":2,"ready":schemars::schema_for!(areal_engine::tools::plugins::NativeHostReady),"hostToCore":schemars::schema_for!(areal_engine::tools::plugins::NativeHostMessage),"coreToHost":schema::native_messages(),"toolResponse":schemars::schema_for!(areal_protocol::DynamicToolResponse),"runtimeError":schemars::schema_for!(areal_runtime_protocol::Error)});
    for (name, value) in output.as_object_mut().unwrap() {
        if name != "protocolVersion" {
            schema::standalone::normalize(value);
        }
    }
    output
}
fn desktop_schema() -> Value {
    let mut methods = serde_json::Map::new();
    macro_rules! add {
        ($name:expr,$type:ty) => {
            methods.insert(
                $name.into(),
                serde_json::to_value(schemars::schema_for!($type)).unwrap(),
            );
        };
    }
    add!("areal/capabilities", CapabilitiesRequest);
    add!(
        "areal/genUi/source",
        areal_protocol::plugin_runtime::GenUiSource
    );
    add!("areal/thread/prediction", PromptPredictionRequest);
    add!(
        "areal/mcp/app/tools/register",
        areal_protocol::plugin_runtime::PageRegister
    );
    add!(
        "areal/mcp/app/tools/revoke",
        areal_protocol::plugin_runtime::PageRevoke
    );
    add!(
        "areal/mcp/app/tools/claim",
        areal_protocol::plugin_runtime::PageCoordinates
    );
    add!(
        "areal/mcp/app/tools/resolve",
        areal_protocol::plugin_runtime::PageResolve
    );
    add!(
        "areal/server/modelConfiguration/read",
        ModelConfigurationRead
    );
    add!(
        "areal/server/modelConfiguration/apply",
        ModelConfigurationApply
    );
    add!(
        "areal/plugin/hooks/list",
        areal_protocol::plugin_runtime::Empty
    );
    add!(
        "areal/plugin/hooks/configure",
        areal_protocol::plugin_runtime::HooksConfigure
    );
    add!(
        "areal/hook/acknowledge",
        areal_protocol::plugin_runtime::HookAcknowledge
    );
    add!(
        "areal/plugin/mcp/list",
        areal_protocol::plugin_runtime::Empty
    );
    add!(
        "areal/plugin/connection",
        areal_protocol::plugin_runtime::Connection
    );
    add!("areal/plugin/auth", areal_protocol::plugin_runtime::Auth);
    add!(
        "areal/mcp/form/resource/prepare",
        areal_protocol::plugin_runtime::FormResourcePrepare
    );
    add!(
        "areal/mcp/form/resource/stage",
        areal_protocol::plugin_runtime::FormResourceStage
    );
    add!(
        "areal/mcp/form/resource/release",
        areal_protocol::plugin_runtime::FormResourceRelease
    );
    add!(
        "areal/plugin/auth/configure",
        areal_protocol::plugin_runtime::AuthConfigure
    );
    add!(
        "areal/plugin/connector/configure",
        areal_protocol::plugin_runtime::Connector
    );
    add!(
        "areal/mcp/tool/result",
        areal_protocol::plugin_runtime::ToolResult
    );
    add!("areal/mcp/apps/list", areal_protocol::plugin_runtime::Apps);
    add!("areal/mcp/app/open", areal_protocol::plugin_runtime::Open);
    add!(
        "areal/mcp/app/openFromResult",
        areal_protocol::plugin_runtime::OpenFromResult
    );
    add!(
        "areal/mcp/app/request",
        areal_protocol::plugin_runtime::AppRequest
    );
    add!("areal/mcp/app/close", areal_protocol::plugin_runtime::Close);
    add!(
        "areal/mcp/extension/call",
        areal_protocol::plugin_runtime::Extension
    );
    add!(
        "areal/mcp/forms/list",
        areal_protocol::plugin_runtime::Forms
    );
    add!(
        "areal/mcp/form/respond",
        areal_protocol::plugin_runtime::Respond
    );
    add!(
        "areal/mcp/form/preview",
        areal_protocol::plugin_runtime::Preview
    );
    add!("areal/work/overview", areal_protocol::work::OverviewRequest);
    add!("areal/goal/create", areal_protocol::goals::GoalCreate);
    add!("areal/task/create", areal_protocol::tasks::TaskCreate);
    add!("areal/task/update", areal_protocol::tasks::TaskUpdate);
    add!(
        "areal/task/schedule/context",
        areal_protocol::tasks::ScheduleContextInput
    );
    add!(
        "areal/task/schedule/preview",
        areal_protocol::tasks::SchedulePreview
    );
    add!("areal/task/runNow", areal_protocol::tasks::TaskRunNow);
    add!("areal/task/runs/list", areal_protocol::tasks::TaskRunsList);
    methods.get_mut("areal/task/runs/list").unwrap()["properties"]["limit"] =
        json!({"type":["integer","null"],"minimum":1,"maximum":100});
    add!("areal/task/run/read", areal_protocol::tasks::TaskRunRead);
    add!("areal/task/pause", areal_protocol::tasks::TaskControl);
    for method in ["areal/task/stopRun", "areal/task/resumeRun"] {
        let mut control =
            serde_json::to_value(schemars::schema_for!(areal_protocol::tasks::TaskControl))
                .unwrap();
        control["required"]
            .as_array_mut()
            .unwrap()
            .push(json!("expectedRunId"));
        control["properties"]["expectedRunId"] = json!({"type":"string"});
        methods.insert(method.into(), control);
    }
    for action in [
        "areal/task/resume",
        "areal/task/cancel",
        "areal/task/delete",
    ] {
        let mut control =
            serde_json::to_value(schemars::schema_for!(areal_protocol::tasks::TaskControl))
                .unwrap();
        control["properties"]
            .as_object_mut()
            .unwrap()
            .remove("expectedRunId");
        methods.insert(action.into(), control);
    }
    for action in [
        "areal/task/read",
        "areal/task/subscribe",
        "areal/task/unsubscribe",
    ] {
        add!(action, areal_protocol::tasks::TaskTarget);
    }
    for action in ["areal/task/list", "areal/inbox/list"] {
        add!(action, areal_protocol::tasks::TaskList);
    }
    add!("areal/channel/read", areal_protocol::tasks::ChannelRead);
    add!("areal/channel/reply", areal_protocol::tasks::ChannelReply);
    add!("areal/goal/update", areal_protocol::goals::GoalUpdate);
    for action in ["areal/goal/pause", "areal/goal/resume", "areal/goal/clear"] {
        add!(action, areal_protocol::goals::GoalControl);
    }
    add!("areal/subscription/remove", RemoveSubscriptions);
    add!("areal/thread/start", ThreadStart);
    add!("areal/thread/tools/attach", AttachBrowserTools);
    add!("areal/thread/observe", ObserveThread);
    add!("areal/thread/configure", ConfigureThread);
    add!("areal/turn/start", TurnStart);
    add!("areal/turn/enqueue", TurnStart);
    add!("areal/turn/submit", TurnSubmit);
    add!("areal/queue/steer", QueueSteer);
    add!("areal/plan/update", PlanUpdate);
    add!("areal/interaction/respond", Respond);
    add!("areal/process/start", ProcessStart);
    add!("areal/agent/spawn", AgentSpawn);
    add!(
        "areal/agent/delegate",
        areal_protocol::delegation::DelegationRequest
    );
    add!("areal/thread/fork", ForkThread);
    add!("areal/side/start", SideStart);
    add!("areal/side/create", SideCreate);
    add!("areal/side/close", SideClose);
    add!("areal/profile/read", VersionRef);
    add!("areal/workflow/read", VersionRef);
    add!(
        "areal/workgroup/start",
        areal_engine::workgroup::service::Start
    );
    let string = json!({"type":"string"});
    let integer = json!({"type":"integer","minimum":0});
    let empty = json!({"type":"object","properties":{},"additionalProperties":false});
    for method in [
        "areal/task/host/ready",
        "areal/model/list",
        "areal/profile/list",
        "areal/provider/list",
        "areal/server/status",
        "areal/server/gc",
        "areal/mcp/list",
        "areal/plugin/list",
        "areal/workflow/list",
    ] {
        methods.insert(method.into(), empty.clone());
    }
    let object = |properties: Value, required: Vec<&str>| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    for method in [
        "areal/goal/get",
        "areal/thread/inspect",
        "areal/thread/archive",
        "areal/thread/closeResources",
        "areal/skill/list",
        "areal/plan/read",
        "areal/interaction/list",
        "areal/permissions/read",
        "areal/queue/list",
        "areal/process/list",
        "areal/context/compact",
    ] {
        methods.insert(
            method.into(),
            object(json!({"threadId":string}), vec!["threadId"]),
        );
    }
    methods.insert(
        "areal/permissions/forget".into(),
        object(
            json!({"threadId":string,"project":{"type":"boolean"}}),
            vec!["threadId"],
        ),
    );
    for method in ["areal/provider/read", "areal/mcp/read", "areal/plugin/read"] {
        methods.insert(method.into(), object(json!({"id":string}), vec!["id"]));
    }
    let scope = json!({"enum":["user","project"]});
    methods.insert(
        "areal/marketplace/add".into(),
        object(
            json!({"root":string,"expectedRevision":integer,"requestId":string}),
            vec!["root", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/plugin/resolve".into(),
        object(
            json!({"id":string,"expectedRevision":integer,"requestId":string}),
            vec!["id", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/plugin/importArchive".into(),
        object(
            json!({"path":string,"expectedRevision":integer,"requestId":string}),
            vec!["path", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/marketplace/addGit".into(),
        object(
            json!({"url":string,"refName":string,"sparsePaths":{"type":"array","items":string},"expectedRevision":integer,"requestId":string}),
            vec!["url", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/marketplace/remove".into(),
        object(
            json!({"root":string,"expectedRevision":integer,"requestId":string}),
            vec!["root", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/marketplace/update".into(),
        object(
            json!({"expectedRevision":integer,"requestId":string}),
            vec!["expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/plugin/install".into(),
        object(
            json!({"id":string,"scope":scope,"expectedRevision":integer,"source":string,
            "expectedDigest":{"type":"string","pattern":"^[0-9a-f]{64}$"},"requestId":string}),
            vec![
                "id",
                "scope",
                "expectedRevision",
                "source",
                "expectedDigest",
                "requestId",
            ],
        ),
    );
    methods.insert("areal/plugin/configure".into(), object(
        json!({"id":string,"scope":scope,"enabled":{"type":"boolean"},"expectedRevision":integer,"requestId":string}),
        vec!["id","scope","enabled","expectedRevision","requestId"]));
    methods.insert("areal/plugin/component/configure".into(), object(
        json!({"id":string,"component":schemars::schema_for!(areal_plugins::PluginComponentId),"enabled":{"type":"boolean"},"expectedRevision":integer,"expectedDigest":{"type":"string","pattern":"^[0-9a-f]{64}$"},"requestId":string}),
        vec!["id","component","enabled","expectedRevision","expectedDigest","requestId"]));
    methods.insert(
        "areal/plugin/uninstall".into(),
        object(
            json!({"id":string,"expectedRevision":integer,"requestId":string}),
            vec!["id", "expectedRevision", "requestId"],
        ),
    );
    methods.insert(
        "areal/plugin/setup".into(),
        object(
            json!({"id":string,"threadId":string,"requestId":string}),
            vec!["id", "requestId"],
        ),
    );
    for method in [
        "areal/provider/remove",
        "areal/mcp/connect",
        "areal/mcp/disconnect",
    ] {
        methods.insert(
            method.into(),
            object(
                json!({"id":string,"expectedRevision":integer}),
                vec!["id", "expectedRevision"],
            ),
        );
    }
    methods.insert(
        "areal/provider/upsert".into(),
        object(
            json!({"expectedRevision":integer,"provider":schemars::schema_for!(Provider)}),
            vec!["provider", "expectedRevision"],
        ),
    );
    methods.insert("areal/context/read".into(),object(json!({"threadId":string,"offset":integer,"limit":{"type":"integer","minimum":1,"maximum":32}}),vec!["threadId"]));
    methods.insert(
        "areal/request/read".into(),
        json!({"oneOf":[
            object(json!({"threadId":string,"requestId":string}),vec!["requestId"]),
            schemars::schema_for!(areal_protocol::tasks::TaskRunNow)
        ]}),
    );
    methods.insert("areal/server/drain".into(),object(json!({"strategy":{"enum":["wait","cancel","ifIdle"]},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["strategy","timeoutMs"]));
    methods.insert(
        "areal/blob/release".into(),
        object(
            json!({"threadId":string,"uri":string}),
            vec!["threadId", "uri"],
        ),
    );
    methods.insert("areal/skill/read".into(),object(json!({"threadId":string,"skill":schemars::schema_for!(VersionRef),"resource":string,"offset":integer,"maxBytes":{"type":"integer","minimum":1,"maximum":8192}}),vec!["threadId","skill"]));
    methods.insert("areal/execution/list".into(), object(json!({"parentThreadId":string,"offset":integer,"limit":{"type":"integer","minimum":1,"maximum":100}}), vec!["parentThreadId"]));
    methods.insert(
        "areal/execution/read".into(),
        object(
            json!({"parentThreadId":string,"executionId":string,"offset":integer}),
            vec!["parentThreadId", "executionId"],
        ),
    );
    methods.insert(
        "areal/execution/apply".into(),
        object(
            json!({"parentThreadId":string,"executionId":string}),
            vec!["parentThreadId", "executionId"],
        ),
    );
    methods.insert(
        "areal/execution/artifact".into(),
        object(
            json!({"parentThreadId":string,"executionId":string,"path":string,"offset":integer}),
            vec!["parentThreadId", "executionId"],
        ),
    );
    methods.insert("areal/execution/wait".into(), object(json!({"parentThreadId":string,"executionId":string,"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}), vec!["parentThreadId", "executionId"]));
    methods.insert("areal/execution/cancel".into(), object(json!({"parentThreadId":string,"executionId":string,"mode":{"enum":["graceful","force"]}}), vec!["parentThreadId", "executionId"]));
    methods.insert("areal/agent/wait".into(),object(json!({"parentThreadId":string,"threadIds":{"type":"array","items":string,"minItems":1,"maxItems":16,"uniqueItems":true},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["parentThreadId","threadIds"]));
    for action in ["update", "remove", "reorder", "pause", "resume"] {
        let required = match action {
            "update" => vec!["threadId", "expectedRevision", "queueItemId", "input"],
            "remove" => vec!["threadId", "expectedRevision", "queueItemId"],
            "reorder" => vec!["threadId", "expectedRevision", "queueItemIds"],
            _ => vec!["threadId", "expectedRevision"],
        };
        methods.insert(format!("areal/queue/{action}"),object(json!({"threadId":string,"expectedRevision":integer,"queueItemId":string,"queueItemIds":{"type":"array","items":string},"input":{"type":"array","items":schemars::schema_for!(areal_protocol::Input)}}),required));
    }
    for action in [
        "get",
        "read",
        "write",
        "resize",
        "closeStdin",
        "terminate",
        "wait",
    ] {
        let mut fields = json!({"threadId":string,"id":string});
        let mut required = vec!["threadId", "id"];
        match action {
            "read" => {
                fields["after"] = json!({"type":["string","null"]});
                fields["maxBytes"] = json!({"type":"integer","minimum":1,"maximum":1048576});
                fields["waitMs"] = json!({"type":"integer","minimum":0,"maximum":1000});
            }
            "wait" => {
                fields["timeoutMs"] = json!({"type":"integer","minimum":0,"maximum":60000});
                required.push("timeoutMs");
            }
            "get" => {}
            _ => {
                fields["requestId"] = string.clone();
                required.push("requestId");
                if action == "write" {
                    fields["dataBase64"] = string.clone();
                    required.push("dataBase64");
                }
                if action == "resize" {
                    fields["cols"] = json!({"type":"integer","minimum":1,"maximum":65535});
                    fields["rows"] = fields["cols"].clone();
                    required.extend(["cols", "rows"]);
                }
            }
        }
        methods.insert(format!("areal/process/{action}"), object(fields, required));
    }
    methods.insert(
        "areal/provider/probe".into(),
        object(json!({"id":string,"model":string}), vec!["id"]),
    );
    methods.insert("areal/process/acknowledgeCleanup".into(),object(json!({"threadId":string,"id":string,"note":{"type":"string","minLength":1,"maxLength":4096}}),vec!["threadId","id","note"]));
    methods.insert("areal/mcp/configure".into(),object(json!({"id":string,"expectedRevision":integer,"config":schemars::schema_for!(areal_mcp::ServerConfig)}),vec!["id","expectedRevision","config"]));
    methods.insert("areal/workflow/start".into(),object(json!({"workflow":schemars::schema_for!(VersionRef),"requestId":string,"workers":integer,"admission":schemars::schema_for!(areal_engine::workgroup::Admission)}),vec!["workflow","requestId"]));
    for method in ["areal/workgroup/list", "areal/workgroup/policy"] {
        methods.insert(method.into(), empty.clone());
    }
    for method in ["areal/workgroup/read", "areal/workgroup/cancel"] {
        methods.insert(method.into(), object(json!({"id":string}), vec!["id"]));
    }
    methods.insert("areal/workgroup/wait".into(),object(json!({"id":string,"afterRevision":integer,"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["id","afterRevision","timeoutMs"]));
    methods.insert(
        "areal/workgroup/artifact".into(),
        object(
            json!({"id":string,"path":{"type":["string","null"]},"offset":integer}),
            vec!["id"],
        ),
    );
    methods.insert("areal/workgroup/revise".into(),object(json!({"id":string,"requestId":string,"expectedRevision":integer,"plan":schemars::schema_for!(areal_engine::workgroup::Plan)}),vec!["id","requestId","expectedRevision","plan"]));
    methods.insert(
        "areal/agent/list".into(),
        object(json!({"parentThreadId":string}), vec!["parentThreadId"]),
    );
    methods.insert(
        "areal/tool/acknowledge".into(),
        object(
            json!({"threadId":string,"itemId":string,"inspection":string}),
            vec!["threadId", "itemId", "inspection"],
        ),
    );
    let nullable_string = json!({"type":["string","null"]});
    methods.insert("initialize".into(),object(json!({"clientInfo":object(json!({"name":string,"version":string,"title":nullable_string}),vec!["name","version"]),"capabilities":object(json!({"optOutNotificationMethods":{"type":"array","items":string},"experimentalApi":{"type":"boolean"}}),vec![])}),vec!["clientInfo"]));
    methods.insert("model/list".into(), empty.clone());
    methods.insert("thread/start".into(),object(json!({"cwd":nullable_string,"model":nullable_string,"dynamicTools":{"type":"array","items":schemars::schema_for!(areal_protocol::ToolDefinition)}}),vec![]));
    add!("thread/resume", ObserveThread);
    methods.insert(
        "thread/read".into(),
        object(
            json!({"threadId":string,"includeTurns":{"type":"boolean"}}),
            vec!["threadId"],
        ),
    );
    for method in ["thread/list", "areal/agent/list"] {
        methods.insert(
            method.into(),
            object(
                json!({"cursor":nullable_string,"limit":integer,"parentThreadId":nullable_string}),
                vec![],
            ),
        );
    }
    methods.insert("turn/start".into(),object(json!({"threadId":string,"input":{"type":"array","items":schemars::schema_for!(areal_protocol::Input)}}),vec!["threadId","input"]));
    methods.insert("areal/conversation/history".into(),object(json!({"threadId":string,"view":{"enum":["own","inherited","reference"]},"cursor":string,"maxBytes":{"type":"integer","minimum":1,"maximum":1048576}}),vec!["threadId","view"]));
    methods.get_mut("areal/conversation/history").unwrap()["allOf"] = json!([{
        "if":{"properties":{"view":{"enum":["inherited","reference"]}}},
        "then":{"properties":{"maxBytes":{"maximum":262144}}}
    }]);
    methods.insert("areal/conversation/list".into(),object(json!({"view":{"enum":["main","side","all"]},"sourceThreadId":string,"includeArchived":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":100},"cursor":string}),vec![]));
    methods.insert(
        "areal/conversation/unarchive".into(),
        object(
            json!({"requestId":string,"threadId":string}),
            vec!["requestId", "threadId"],
        ),
    );
    methods.insert("areal/side/context/read".into(),object(json!({"threadId":string,"evidenceRef":string,"cursor":string,"maxBytes":{"type":"integer","minimum":64,"maximum":16384}}),vec!["threadId"]));
    methods.insert("turn/steer".into(),object(json!({"requestId":string,"threadId":string,"expectedTurnId":string,"input":{"type":"array","items":schemars::schema_for!(areal_protocol::Input)}}),vec!["threadId","expectedTurnId","input"]));
    add!("turn/interrupt", TurnInterrupt);
    for (method, schema) in &mut methods {
        if matches!(
            method.as_str(),
            "areal/thread/configure"
                | "areal/plan/update"
                | "areal/provider/upsert"
                | "areal/provider/remove"
                | "areal/mcp/configure"
                | "areal/mcp/connect"
                | "areal/mcp/disconnect"
                | "areal/queue/update"
                | "areal/queue/remove"
                | "areal/queue/reorder"
                | "areal/queue/pause"
                | "areal/queue/resume"
                | "areal/thread/archive"
                | "areal/blob/release"
        ) {
            schema["properties"]["requestId"] =
                json!({"type":"string","minLength":1,"maxLength":128});
        }
    }
    let mut output = json!({"apiVersion":API_VERSION,"requests":methods,"thread":schemars::schema_for!(areal_protocol::Thread),"turn":schemars::schema_for!(areal_protocol::Turn),"profile":schemars::schema_for!(AgentProfile),"interaction":schemars::schema_for!(Interaction),"queue":schemars::schema_for!(Queue),"process":schemars::schema_for!(ManagedProcess),"provider":schemars::schema_for!(Provider),"workflow":schemars::schema_for!(areal_engine::desktop::Workflow),"effectiveConfig":schemars::schema_for!(EffectiveConfig),"media":schemars::schema_for!(areal_protocol::MediaRef)});
    let (responses, notifications) = schema::projections();
    output["responses"] = responses;
    output["notifications"] = notifications;
    schema::plugins::codex_management(&mut output);
    let requests = output["requests"].as_object().unwrap();
    let responses = output["responses"].as_object().unwrap();
    assert_eq!(
        requests.keys().collect::<Vec<_>>(),
        responses.keys().collect::<Vec<_>>(),
        "every desktop method requires both request and response schemas"
    );
    for method in NOTIFICATIONS {
        assert!(
            output["notifications"].get(*method).is_some(),
            "advertised notification lacks schema: {method}"
        );
    }
    let browser_request = object(
        json!({"threadId":string,"turnId":string,"callId":string,"tool":string,"arguments":{},"hostGeneration":string}),
        vec![
            "threadId",
            "turnId",
            "callId",
            "tool",
            "arguments",
            "hostGeneration",
        ],
    );
    output["serverRequests"] = json!({"item/tool/call":browser_request,
        "areal/browser/prepare":object(json!({"threadId":string,"turnId":string,"callId":string,"tool":string,"arguments":{},"hostGeneration":string}),vec!["threadId","turnId","callId","tool","arguments","hostGeneration"])});
    output["serverRequests"]["item/tool/call"]["properties"]["browserApproval"] = json!({"type":"object","properties":{"plan":{"type":"object"}},"required":["plan"],"additionalProperties":false});
    output["serverRequests"]["item/tool/call"]["properties"]["computerApproval"] =
        output["serverRequests"]["item/tool/call"]["properties"]["browserApproval"].clone();
    output["serverRequests"]["areal/computer/prepare"] =
        output["serverRequests"]["areal/browser/prepare"].clone();
    output["serverRequests"]["areal/computer/prepare"]["properties"]["discardPreparedPlan"] =
        json!({"type":"boolean"});
    output["serverRequests"]["areal/computer/prepare"]["properties"]["computerApproval"] =
        output["serverRequests"]["item/tool/call"]["properties"]["computerApproval"].clone();
    output["serverRequests"]["areal/cua/turnEnded"] = object(
        json!({"threadId":string,"turnId":string,"hostGeneration":string,"event":{"enum":["Stop","Interrupt"]}}),
        vec!["threadId", "turnId", "hostGeneration", "event"],
    );
    output["serverRequests"]["areal/task/prepare"] = object(
        json!({"taskId":string,"runId":string,"threadId":string,"scheduledAt":integer,"intent":{"enum":["start","resume"]}}),
        vec!["taskId", "runId", "threadId", "scheduledAt", "intent"],
    );
    output["serverResponses"] = json!({"item/tool/call":schemars::schema_for!(areal_protocol::DynamicToolResponse),"areal/browser/prepare":{"type":"object"},"areal/task/prepare":{"type":"object"}});
    output["serverResponses"]["areal/computer/prepare"] = json!({"type":"object"});
    output["serverResponses"]["areal/cua/turnEnded"] = empty;
    for method in SERVER_REQUESTS {
        assert!(
            output["serverRequests"].get(*method).is_some()
                && output["serverResponses"].get(*method).is_some(),
            "advertised server request lacks request or response schema: {method}"
        );
    }
    for (name, value) in output.as_object_mut().unwrap() {
        match name.as_str() {
            "apiVersion" => {}
            "requests" | "responses" | "notifications" | "serverRequests" | "serverResponses" => {
                for schema in value.as_object_mut().unwrap().values_mut() {
                    schema::standalone::normalize(schema);
                }
            }
            _ => schema::standalone::normalize(value),
        }
    }
    output
}
