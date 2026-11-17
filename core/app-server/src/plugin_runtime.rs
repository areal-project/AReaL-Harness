//! 包绑定的普通 MCP 连接、扩展和表单路由。
use super::*;
areal_protocol::method_catalog! {
    "areal/plugin/mcp/list" => Read;
    "areal/plugin/components" => Read;
    "areal/plugin/userConfig/set" => Mutation, Management;
    "areal/plugin/development/link" => Mutation, Management;
    "areal/plugin/development/unlink" => Mutation, Management;
    "areal/plugin/hooks/list" => Read;
    "areal/plugin/hooks/configure" => Mutation, Management;
    "areal/hook/acknowledge" => Mutation, Management;
    "areal/plugin/connection" => Mutation, Management;
    "areal/plugin/auth" => Mutation;
    "areal/plugin/auth/configure" => Mutation, Management;
    "areal/plugin/credentials/register" => Mutation, Management;
    "areal/mcp/tool/result" => Read;
    "areal/mcp/extension/call" => Mutation;
    "areal/mcp/forms/list" => Read;
    "areal/mcp/form/respond" => Mutation;
    "areal/mcp/form/preview" => Mutation;
    "areal/mcp/form/resource/prepare" => Mutation;
    "areal/mcp/form/resource/stage" => Mutation, Management;
    "areal/mcp/form/resource/release" => Mutation;
}
use areal_protocol::plugin_runtime::*;
pub(crate) async fn dispatch(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    if matches!(
        method,
        "areal/plugin/userConfig/set"
            | "areal/plugin/development/link"
            | "areal/plugin/development/unlink"
            | "areal/plugin/hooks/configure"
            | "areal/hook/acknowledge"
            | "areal/plugin/connection"
            | "areal/plugin/auth/configure"
            | "areal/mcp/form/resource/stage"
    ) {
        let request = params
            .get("requestId")
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|v| !v.is_empty())
            .ok_or_else(|| RpcError::invalid("requestId is required"))?;
        let owned = identity.to_owned();
        let method = method.to_owned();
        let snapshot = params.clone();
        let reply = engine
            .management_submission(
                identity.into(),
                request,
                method.clone(),
                snapshot,
                move |engine| async move {
                    match dispatch_inner(&engine, &owned, &method, params).await {
                        Ok(v) => json!({"result":v}),
                        Err(e) => json!({"error":e}),
                    }
                },
            )
            .await
            .map_err(map_error)?;
        if let Some(error) = reply.get("error") {
            return Err(RpcError {
                code: error["code"].as_i64().unwrap_or(-32603),
                message: error["message"]
                    .as_str()
                    .unwrap_or("plugin management failed")
                    .into(),
                data: error.get("data").cloned(),
            });
        };
        return Ok(reply["result"].clone());
    }
    dispatch_inner(engine, identity, method, params).await
}
async fn dispatch_inner(
    engine: &Arc<Engine>,
    identity: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcError> {
    let result = match method {
        "areal/plugin/userConfig/set" => engine.plugin_user_configure(parse(params)?).await,
        "areal/plugin/development/link" => engine.plugin_development_link(parse(params)?).await,
        "areal/plugin/development/unlink" => engine.plugin_development_unlink(parse(params)?).await,
        "areal/plugin/components" => {
            let p: ComponentRead = parse(params)?;
            engine.plugin_component_summary(p.id).await
        }
        "areal/mcp/tool/result" => {
            let p: ToolResult = parse(params)?;
            engine.mcp_tool_result(p.thread_id, p.call_id).await
        }
        "areal/plugin/hooks/list" => {
            let _: Empty = parse(params)?;
            engine.plugin_hooks_list().await
        }
        "areal/plugin/hooks/configure" => {
            let p: HooksConfigure = parse(params)?;
            engine.plugin_hooks_configure(p).await
        }
        "areal/hook/acknowledge" => {
            let p: HookAcknowledge = parse(params)?;
            engine.hook_acknowledge(p).await
        }
        "areal/plugin/mcp/list" => {
            let _: Empty = parse(params)?;
            engine.plugin_mcp_list().await
        }
        "areal/plugin/connection" => {
            let p: areal_protocol::plugin_runtime::Connection = parse(params)?;
            engine
                .plugin_connection(p.id, p.expected_digest, p.connect)
                .await
        }
        "areal/plugin/auth/configure" => {
            let p: AuthConfigure = parse(params)?;
            engine.plugin_auth_configure(p).await
        }
        "areal/plugin/auth" => {
            let p: Auth = parse(params)?;
            engine.plugin_auth(p.id, p.server, p.operation).await
        }
        "areal/plugin/credentials/register" => {
            let p: CredentialsRegister = parse(params)?;
            engine.register_credentials(p.credentials)
        }
        "areal/mcp/extension/call" => {
            let p: areal_protocol::plugin_runtime::Extension = parse(params)?;
            engine
                .mcp_extension_call(
                    identity.into(),
                    p.thread_id,
                    (p.server_id, p.expected_generation),
                    p.kind,
                    p.arguments,
                    p.request_id,
                )
                .await
        }
        "areal/mcp/forms/list" => {
            let p: Forms = parse(params)?;
            engine.mcp_forms_list(p.thread_id).await
        }
        "areal/mcp/form/preview" => {
            let p: Preview = parse(params)?;
            engine
                .mcp_form_preview(identity.into(), p.thread_id, p.request_id, p.target)
                .await
        }
        "areal/mcp/form/resource/prepare" => {
            let p: FormResourcePrepare = parse(params)?;
            engine
                .mcp_form_resource_prepare(identity.into(), p.thread_id, p.request_id, p.field_name)
                .await
        }
        "areal/mcp/form/resource/stage" => {
            let p: FormResourceStage = parse(params)?;
            engine
                .mcp_form_resource_stage(identity.into(), p.selection_token, p.paths)
                .await
        }
        "areal/mcp/form/resource/release" => {
            let p: FormResourceRelease = parse(params)?;
            engine
                .mcp_form_resource_release(
                    identity.into(),
                    p.thread_id,
                    p.request_id,
                    p.field_name,
                    p.uri,
                )
                .await
        }
        "areal/mcp/form/respond" => {
            let p: Respond = parse(params)?;
            engine
                .mcp_form_respond(identity.into(), p.thread_id, p.request_id, p.response)
                .await
        }
        _ => return Err(RpcError::invalid("unsupported plugin runtime method")),
    };
    result.map_err(map_error)
}
