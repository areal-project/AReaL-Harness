use super::*;
use areal_protocol::ToolDefinition;

pub(crate) fn definitions() -> Vec<ToolDefinition> {
    let reference = json!({"type":"object","properties":{"id":{"type":"string"},"revision":{"type":"string"}},"required":["id","revision"],"additionalProperties":false});
    [
        ("agent_spawn_configured","Create a bounded child agent using the same Core loop. Shared read-only children inherit narrowed parent permissions.",json!({"input":{"type":"array","minItems":1,"items":{"type":"object","properties":{"type":{"const":"text"},"text":{"type":"string"}},"required":["type","text"],"additionalProperties":false}},"instructions":{"type":"string"},"agentProfile":reference.clone(),"skills":{"type":"array","items":reference.clone()},"model":{"type":"object","properties":{"providerId":{"type":"string"},"modelId":{"type":"string"}},"required":["providerId","modelId"],"additionalProperties":false},"toolAllowlist":{"type":"array","items":{"type":"string"}},"workspaceMode":{"enum":["sharedReadOnly","isolatedWrite"]},"writes":{"type":"array","maxItems":256,"items":{"type":"string"}}}),vec!["input"]),
        ("agent_wait_all","Wait for child settlement and consume authoritative results as a tool result.",json!({"threadIds":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"string"}},"timeoutMs":{"type":"integer","minimum":0,"maximum":60000}}),vec!["threadIds"]),
        ("ask_user_question","Ask the user up to eight questions. Waits without holding model capacity; Stop expires the request.",json!({"questions":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"options":{"type":"array","items":{"type":"string"}},"allowFreeText":{"type":"boolean"}},"required":["id","title"],"additionalProperties":false}},"timeoutSeconds":{"type":"integer","minimum":1,"maximum":3600}}),vec!["questions"]),
        ("plan_read","Read the authoritative plan and revision for this thread.",json!({}),vec![]),
        ("plan_update","Replace the plan using its current revision. States are pending, inProgress, completed, cancelled.",json!({"expectedRevision":{"type":"integer","minimum":0},"steps":{"type":"array","maxItems":64,"items":{"type":"object","properties":{"id":{"type":"string"},"text":{"type":"string"},"status":{"enum":["pending","inProgress","completed","cancelled"]}},"required":["id","text","status"],"additionalProperties":false}}}),vec!["expectedRevision","steps"]),
        ("skill_list","List available skills with names and descriptions. Attachments are not scanned; read SKILL.md for their paths.",json!({}),vec![]),
        ("skill_read","Read SKILL.md or a referenced resource on demand, up to 8192 bytes per call. All skills read current files, including explicitly deployed skills. Follow nextOffset to read more.",json!({"skill":reference,"resource":{"type":"string"},"offset":{"type":"integer","minimum":0},"maxBytes":{"type":"integer","minimum":1,"maximum":8192}}),vec!["skill"]),
    ].into_iter().map(|(name, description, properties, required)|ToolDefinition {name:name.into(),description:description.into(),input_schema:json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}),output_schema:None}).collect()
}
impl Engine {
    pub(crate) async fn core_tool(
        self: &Arc<Self>,
        cell: &Cell,
        call_id: &str,
        tool: &str,
        args: &Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let thread_id = cell.state.lock().await.thread.id.clone();
        match tool {
            "agent_spawn_configured" => {
                let mut request = args.clone();
                request["parentThreadId"] = json!(thread_id);
                let mut result = self
                    .spawn_agent(serde_json::from_value(request).map_err(invalid)?)
                    .await?;
                result.as_object_mut().unwrap().remove("thread");
                result.as_object_mut().unwrap().remove("turn");
                Ok(result)
            }
            "agent_wait_all" => {
                self.wait_children(
                    &thread_id,
                    serde_json::from_value(args["threadIds"].clone()).map_err(invalid)?,
                    args["timeoutMs"].as_u64().unwrap_or(60000),
                )
                .await
            }

            "ask_user_question" => {
                self.await_interaction(
                    cell,
                    call_id,
                    serde_json::from_value(args["questions"].clone()).map_err(invalid)?,
                    None,
                    cancel,
                    args["timeoutSeconds"].as_u64().unwrap_or(300),
                )
                .await
            }
            "plan_read" => Ok(json!(self.plan(&thread_id).await?)),
            "plan_update" => {
                let request = PlanUpdate {
                    thread_id,
                    expected_revision: args["expectedRevision"]
                        .as_u64()
                        .ok_or_else(|| invalid("expectedRevision required"))?,
                    steps: serde_json::from_value(args["steps"].clone()).map_err(invalid)?,
                };
                Ok(json!(self.update_plan_inner(request).await?))
            }
            "skill_list" => self.skills(&thread_id).await,
            "skill_read" => {
                self.read_skill(
                    &thread_id,
                    serde_json::from_value(args["skill"].clone()).map_err(invalid)?,
                    args["resource"].as_str().unwrap_or("SKILL.md"),
                    args["offset"].as_u64().unwrap_or(0) as usize,
                    args["maxBytes"].as_u64().unwrap_or(8192) as usize,
                )
                .await
            }
            _ => Err(invalid("unknown Core tool")),
        }
    }
}
