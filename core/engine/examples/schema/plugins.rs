use super::*;
use serde_json::Map;

pub fn codex_management(output: &mut Value) {
    let methods: Value = serde_json::from_str(include_str!(
        "../../../../upstream/schemas/codex-plugins-0.162.1/methods.json"
    ))
    .unwrap();
    for (method, contract) in methods.as_object().unwrap() {
        output["requests"][method] = contract["request"].clone();
        output["responses"][method] = contract["response"].clone();
    }
}

pub fn projections(responses: &mut Map<String, Value>, notifications: &mut Map<String, Value>) {
    let string = json!({"type":"string"});
    let number = json!({"type":"integer","minimum":0});
    let boolean = json!({"type":"boolean"});
    let any_object = json!({"type":"object"});
    let mut insert = |names: &[&str], value: Value| {
        for name in names {
            responses.insert(format!("areal/{name}"), value.clone());
        }
    };
    insert(
        &["genUi/source"],
        object(json!({
            "text":string,"readOnly":boolean,
            "artifacts":array(object(json!({
                "artifactId":string,"path":string,"digest":string,"blob":string,
                "threadId":string,"turnId":string,"callId":string,"html":string
            })))
        })),
    );
    let catalog = schema::<areal_plugins::PluginList>();
    insert(
        &[
            "plugin/list",
            "plugin/userConfig/set",
            "plugin/development/link",
            "plugin/development/unlink",
        ],
        catalog.clone(),
    );
    insert(
        &["plugin/components"],
        object(json!({
            "pluginId":string,"installedDigest":string,"mcpServers":array(string.clone()),
            "apps":array(any_object.clone()),"appsNeedingAuth":array(any_object.clone()),
            "commands":array(object(json!({"componentId":string,"name":string,"description":string,"argumentHint":nullable(string.clone()),"installedDigest":string}))),
            "agents":array(object(json!({"componentId":string,"name":string,"description":string,"profile":schema::<VersionRef>()}))),
            "agentDiagnostics":array(string.clone()),"developmentError":nullable(string.clone())
        })),
    );
    insert(
        &[
            "marketplace/add",
            "marketplace/addGit",
            "marketplace/remove",
            "marketplace/update",
            "plugin/uninstall",
        ],
        json!({"oneOf":[catalog,object(json!({"revision":number,"catalogRefreshRequired":{"const":true}}))]}),
    );
    insert(
        &[
            "plugin/read",
            "plugin/importArchive",
            "plugin/resolve",
            "plugin/install",
            "plugin/configure",
            "plugin/component/configure",
        ],
        schema::<areal_plugins::PluginDetail>(),
    );
    insert(
        &["plugin/setup"],
        object(json!({"thread":schema::<Thread>(),"turn":schema::<Turn>(),"requestId":string})),
    );
    insert(
        &["turn/submit"],
        json!({"oneOf":[object(json!({"turn":schema::<Turn>()})),object(json!({"queueRevision":number,"configRevision":number,"queueItemId":nullable(string.clone())}))]}),
    );
    let hooks = data(object(json!({
        "pluginId":string,"installedDigest":string,"definitionDigest":string,
        "definitions":array(object(json!({"definition":schema::<areal_plugins::hooks::HookDefinition>(),"trusted":boolean,"readOnlyCommandTrusted":boolean}))),
        "diagnostics":array(string.clone())
    })));
    insert(&["plugin/hooks/list"], hooks);
    insert(
        &["plugin/hooks/configure"],
        object(
            json!({"id":string,"installedDigest":string,"definitionDigest":string,"enabled":boolean,"trusted":boolean,"allowReadOnlyCommands":boolean}),
        ),
    );
    insert(
        &["hook/acknowledge"],
        object(json!({"threadId":string,"invocationId":string,"acknowledged":{"const":true}})),
    );
    let authentication_requirements = object(json!({
        "mode":string,"apiKey":boolean,"clientSecret":boolean,"privateKey":boolean,
        "tokenEndpointAuthMethod":string,"headerScheme":nullable(string.clone()),"cimdFallback":{"const":"dcr"}
    }));
    let redacted_config = object(json!({
        "transport":{"enum":["stdio","streamable-http"]},"enabled":boolean,
        "authentication":boolean,"authenticationSupported":boolean,"authenticationRequirements":nullable(authentication_requirements),
        "startupTimeoutMs":number,"callTimeoutMs":nullable(number.clone()),"enabledTools":nullable(array(string.clone())),"disabledTools":array(string.clone())
    }));
    let plugin_mcp = data(object(json!({
        "pluginId":string,"installedDigest":string,"state":string,"authenticationTiming":{"enum":["ON_INSTALL","ON_USE",null]},"trusted":boolean,
        "servers":array(object(json!({"serverId":string,"projectEnabled":boolean,"state":string,"config":redacted_config,"policy":schema::<areal_mcp::PluginPolicy>(),"authenticationTiming":{"enum":["ON_INSTALL","ON_USE",null]},"authentication":{"enum":["optional","required","none"]}}))),
        "connectors":array(object(json!({"id":string,"state":string}))),
        "diagnostics":array(json!({"anyOf":[string,any_object]}))
    })));
    insert(&["plugin/mcp/list", "plugin/connection"], plugin_mcp);
    insert(
        &["plugin/auth"],
        nullable(schema::<areal_mcp::AuthStatus>()),
    );
    insert(
        &["plugin/auth/configure"],
        object(json!({"pluginId":string,"serverId":string,"state":{"const":"configured"}})),
    );
    insert(
        &["plugin/connector/configure"],
        object(
            json!({"pluginId":string,"connectorId":string,"provider":string,"state":{"const":"mapped"}}),
        ),
    );
    let tool_metadata = object(json!({"name":string,"inputSchema":any_object}));
    let mut tool_result = object(json!({"content":array(object(json!({"type":string})))}));
    tool_result["properties"]["isError"] = boolean.clone();
    tool_result["properties"]["structuredContent"] = json!({});
    tool_result["properties"]["_meta"] = any_object.clone();
    tool_result["properties"]["resultType"] = json!({"const":"complete"});
    let mcp_result = object(
        json!({"serverId":string,"generation":number,"toolMetadata":tool_metadata,"mcpResult":tool_result}),
    );
    insert(&["mcp/tool/result"], mcp_result.clone());
    let mut apps = data(object(json!({
        "serverId":string,"generation":number,"protocolVersion":string,"pluginId":string,"installedDigest":string,
        "tools":array(object(json!({"name":string,"inputSchema":any_object,"toolName":string}))),
        "capabilities":any_object,"title":nullable(string.clone()),"icons":nullable(array(any_object.clone())),"instructions":nullable(string.clone())
    })));
    apps["properties"]["requestEpoch"] = string.clone();
    apps["required"]
        .as_array_mut()
        .unwrap()
        .push(json!("requestEpoch"));
    insert(&["mcp/apps/list"], apps);
    let app = object(json!({
        "instanceId":string,"serverId":string,"generation":number,"toolMetadata":tool_metadata,
        "resource":object(json!({"uri":string,"mimeType":{},"html":string,"_meta":{}})),
        "initialArguments":any_object,"initialResult":nullable(tool_result.clone()),
        "hostContext":object(json!({"threadId":string,"modelContext":{},"deepLink":nullable(string.clone())}))
    }));
    insert(&["mcp/app/open"], app.clone());
    let mut result_open = schema::<areal_protocol::plugin_runtime::ResultOpenReply>();
    for variant in result_open["oneOf"].as_array_mut().unwrap() {
        if variant["properties"].get("instance").is_some() {
            variant["properties"]["instance"] = app.clone();
        }
    }
    insert(&["mcp/app/openFromResult"], result_open);
    insert(
        &["mcp/app/request"],
        json!({"oneOf":[
            object(json!({"jsonrpc":{"const":"2.0"},"id":{},"result":{}})),
            object(json!({"jsonrpc":{"const":"2.0"},"id":{},"error":object(json!({"code":{"type":"integer"},"message":string}))}))
        ]}),
    );
    insert(&["mcp/app/close"], object(json!({"closed":{"const":true}})));
    insert(
        &["mcp/app/tools/register"],
        schema::<areal_protocol::plugin_runtime::PageRegisterReply>(),
    );
    insert(
        &["mcp/app/tools/revoke"],
        schema::<areal_protocol::plugin_runtime::PageRevoked>(),
    );
    insert(
        &["mcp/app/tools/claim"],
        schema::<areal_protocol::plugin_runtime::PageClaimReply>(),
    );
    insert(
        &["mcp/app/tools/resolve"],
        schema::<areal_protocol::plugin_runtime::PageAccepted>(),
    );
    insert(&["mcp/extension/call"], tool_result);
    insert(
        &["mcp/forms/list"],
        data(object(
            json!({"requestId":string,"threadId":string,"turnId":string,"callId":string,"instanceId":nullable(string.clone()),"serverId":string,"generation":number,"message":{},"requestedSchema":any_object}),
        )),
    );
    insert(
        &["mcp/form/respond"],
        object(json!({"responded":{"const":true}})),
    );
    insert(
        &["mcp/form/preview"],
        json!({"oneOf":[
            object(json!({"type":{"const":"resource_link"},"serverId":string,"generation":number,"resource":object(json!({"contents":array(any_object.clone())}))})),
            object(json!({"type":{"const":"mcp_app_tool"},"serverId":string,"generation":number,"toolName":string,"arguments":any_object,"requiresIdleTurn":{"const":true}}))
        ]}),
    );
    insert(
        &["mcp/form/resource/prepare"],
        object(
            json!({"selectionToken":string,"userOptions":any_object,"multiple":boolean,"serverLabel":string}),
        ),
    );
    insert(
        &["mcp/form/resource/stage"],
        object(
            json!({"resources":array(object(json!({"uri":string,"name":string,"mimeType":nullable(string.clone()),"size":number}))),"summary":object(json!({"fileCount":number,"totalBytes":number}))}),
        ),
    );
    insert(
        &["mcp/form/resource/release"],
        object(json!({"released":{"const":true}})),
    );
    notifications.insert(
        "areal/mcp/app/notification".into(),
        object(json!({"threadId":string,"instanceId":string,"generation":number,"notification":object(json!({"jsonrpc":{"const":"2.0"},"method":string,"params":any_object}))})),
    );
    let mut result_event = mcp_result;
    for field in ["threadId", "turnId", "callId", "itemId"] {
        result_event["properties"][field] = string.clone();
        result_event["required"]
            .as_array_mut()
            .unwrap()
            .push(json!(field));
    }
    notifications.insert("areal/mcp/tool/result".into(), result_event);
    notifications.insert(
        "areal/mcp/app/tools/pending".into(),
        schema::<areal_protocol::plugin_runtime::PageCoordinates>(),
    );
    notifications.insert(
        "areal/mcp/app/tools/cancelled".into(),
        schema::<areal_protocol::plugin_runtime::PageCancelled>(),
    );
    notifications.insert(
        "areal/mcp/form/requested".into(),
        object(json!({"threadId":string,"requestId":string,"serverId":string,"generation":number})),
    );
}
