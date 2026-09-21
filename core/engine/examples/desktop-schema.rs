mod schema;
use areal_protocol::desktop::*;
use serde_json::{Value, json};
fn main() {
    if std::env::args().any(|arg| arg == "--native-host") {
        let mut schema = json!({"protocolVersion":2,"ready":schemars::schema_for!(areal_engine::tools::plugins::NativeHostReady),"hostToCore":schemars::schema_for!(areal_engine::tools::plugins::NativeHostMessage),"coreToHost":schema::native_messages(),"toolResponse":schemars::schema_for!(areal_protocol::DynamicToolResponse),"runtimeError":schemars::schema_for!(areal_runtime_protocol::Error)});
        inline(&mut schema, &Value::Null);
        println!("{}", serde_json::to_string_pretty(&schema).unwrap());
        return;
    }
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
    add!("areal/subscription/remove", RemoveSubscriptions);
    add!("areal/thread/start", ThreadStart);
    add!("areal/thread/configure", ConfigureThread);
    add!("areal/turn/start", TurnStart);
    add!("areal/turn/enqueue", TurnStart);
    add!("areal/plan/update", PlanUpdate);
    add!("areal/interaction/respond", Respond);
    add!("areal/process/start", ProcessStart);
    add!("areal/agent/spawn", AgentSpawn);
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
        "areal/model/list",
        "areal/profile/list",
        "areal/provider/list",
        "areal/server/status",
        "areal/server/gc",
        "areal/mcp/list",
        "areal/workflow/list",
    ] {
        methods.insert(method.into(), empty.clone());
    }
    let object = |properties: Value, required: Vec<&str>| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    for method in [
        "areal/thread/inspect",
        "areal/thread/archive",
        "areal/thread/closeResources",
        "areal/skill/list",
        "areal/plan/read",
        "areal/interaction/list",
        "areal/queue/list",
        "areal/process/list",
        "areal/context/compact",
    ] {
        methods.insert(
            method.into(),
            object(json!({"threadId":string}), vec!["threadId"]),
        );
    }
    for method in ["areal/provider/read", "areal/mcp/read"] {
        methods.insert(method.into(), object(json!({"id":string}), vec!["id"]));
    }
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
        object(
            json!({"threadId":string,"requestId":string}),
            vec!["requestId"],
        ),
    );
    methods.insert("areal/server/drain".into(),object(json!({"strategy":{"enum":["wait","cancel"]},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["strategy","timeoutMs"]));
    methods.insert(
        "areal/blob/release".into(),
        object(
            json!({"threadId":string,"uri":string}),
            vec!["threadId", "uri"],
        ),
    );
    methods.insert("areal/skill/read".into(),object(json!({"threadId":string,"skill":schemars::schema_for!(VersionRef),"resource":string,"offset":integer,"maxBytes":{"type":"integer","minimum":1,"maximum":8192}}),vec!["threadId","skill"]));
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
    methods.insert(
        "thread/resume".into(),
        object(json!({"threadId":string}), vec!["threadId"]),
    );
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
    methods.insert("turn/steer".into(),object(json!({"threadId":string,"expectedTurnId":string,"input":{"type":"array","items":schemars::schema_for!(areal_protocol::Input)}}),vec!["threadId","expectedTurnId","input"]));
    methods.insert(
        "turn/interrupt".into(),
        object(
            json!({"threadId":string,"turnId":string}),
            vec!["threadId", "turnId"],
        ),
    );
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
    output["serverRequests"] = json!({"item/tool/call":object(json!({"threadId":string,"turnId":string,"callId":string,"tool":string,"arguments":{},"hostGeneration":string}),vec!["threadId","turnId","callId","tool","arguments","hostGeneration"])});
    output["serverResponses"] =
        json!({"item/tool/call":schemars::schema_for!(areal_protocol::DynamicToolResponse)});
    inline(&mut output, &Value::Null);
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
// 每个生成的 schema 都有自己的定义域；内联后可独立编译嵌套请求。
fn inline(value: &mut Value, inherited: &Value) {
    let defs = value
        .get("$defs")
        .cloned()
        .unwrap_or_else(|| inherited.clone());
    if let Some(reference) = value
        .get("$ref")
        .and_then(Value::as_str)
        .and_then(|r| r.strip_prefix("#/$defs/"))
    {
        *value = defs[reference].clone();
        assert!(!value.is_null(), "unresolved schema reference");
        inline(value, &defs);
        return;
    }
    match value {
        Value::Object(map) => {
            map.remove("$defs");
            map.remove("$schema");
            for child in map.values_mut() {
                inline(child, &defs);
            }
        }
        Value::Array(items) => {
            for child in items {
                inline(child, &defs);
            }
        }
        _ => {}
    }
}
