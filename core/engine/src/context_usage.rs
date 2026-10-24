use super::*;
use areal_protocol::context::{
    ContextBasis, ContextBudget, ContextEstimate, ContextPart, ContextPartKind as Kind,
    ContextScope, ContextUnavailable, ContextUsage, GenerationStats, InstructionAttribution,
};
use sha2::{Digest, Sha256};

fn part(kind: Kind, name: &str, tokens: usize) -> ContextPart {
    ContextPart {
        kind,
        name: name.into(),
        estimated_tokens: tokens as u64,
        children: Vec::new(),
    }
}

pub(crate) struct InstructionText {
    text: String,
    parts: Vec<ContextPart>,
}
impl InstructionText {
    pub(crate) fn new(text: String) -> Self {
        let parts = vec![part(
            Kind::SystemPrompt,
            "基础指令",
            context::text_tokens(&text),
        )];
        Self { text, parts }
    }
    pub(crate) fn push(&mut self, kind: Kind, name: &str, text: &str) {
        let before = context::text_tokens(&self.text);
        self.text.push_str(text);
        self.parts
            .push(part(kind, name, context::text_tokens(&self.text) - before));
    }
    pub(crate) fn finish(self) -> (String, InstructionAttribution) {
        let attribution = InstructionAttribution {
            sha256: format!("{:x}", Sha256::digest(self.text.as_bytes())),
            parts: self.parts,
        };
        (self.text, attribution)
    }
}

fn group(parts: Vec<ContextPart>) -> Vec<ContextPart> {
    let mut groups = BTreeMap::<Kind, BTreeMap<String, u64>>::new();
    for part in parts {
        if part.estimated_tokens > 0 {
            *groups
                .entry(part.kind)
                .or_default()
                .entry(part.name)
                .or_default() += part.estimated_tokens;
        }
    }
    groups
        .into_iter()
        .map(|(kind, entries)| {
            let children: Vec<_> = entries
                .into_iter()
                .map(|(name, tokens)| part(kind, &name, tokens as usize))
                .collect();
            ContextPart {
                kind,
                name: String::new(),
                estimated_tokens: children.iter().map(|part| part.estimated_tokens).sum(),
                children,
            }
        })
        .collect()
}

fn budget(limits: &Limits, model: &dyn Model) -> anyhow::Result<ContextBudget> {
    let resolved = context::ContextBudget::resolve(limits, model)?;
    let capabilities = model.capabilities();
    let metadata = capabilities.context_window;
    Ok(ContextBudget {
        window_tokens: resolved.window,
        output_reserve_tokens: resolved.reserve,
        input_limit_tokens: resolved.input_limit,
        window_source: metadata.as_ref().map(|window| window.source).unwrap_or(
            if capabilities.context_window_tokens.is_some() {
                areal_protocol::context::ContextWindowSource::ModelDefault
            } else {
                areal_protocol::context::ContextWindowSource::Fallback
            },
        ),
        reported_window_tokens: metadata
            .as_ref()
            .and_then(|window| window.reported_window_tokens),
        reported_window_source: metadata
            .as_ref()
            .and_then(|window| window.reported_window_source),
        user_budget_tokens: metadata
            .as_ref()
            .and_then(|window| window.user_budget_tokens),
    })
}

fn basis(
    configuration: &areal_protocol::desktop::EffectiveConfig,
    model: Option<&dyn Model>,
    turn: Option<&Turn>,
) -> ContextBasis {
    ContextBasis {
        provider: configuration
            .model
            .as_ref()
            .map(|model| model.provider_id.clone())
            .unwrap_or_else(|| model.map_or("", Model::provider).into()),
        model: configuration
            .model
            .as_ref()
            .map(|model| model.model_id.clone())
            .unwrap_or_else(|| model.map_or("", Model::name).into()),
        configuration_revision: configuration.revision,
        default_model_revision: configuration.default_model_revision.clone(),
        turn_id: turn.map(|turn| turn.id.clone()),
    }
}

impl Engine {
    pub(crate) fn context_configuration(
        &self,
        thread: &Thread,
        active: bool,
    ) -> areal_protocol::desktop::EffectiveConfig {
        if active {
            thread
                .turns
                .last()
                .and_then(|turn| turn.configuration.clone())
                .unwrap_or_default()
        } else {
            self.next_request_configuration(
                thread
                    .desktop
                    .as_ref()
                    .map(|desktop| desktop.configuration.clone())
                    .or_else(|| {
                        thread
                            .turns
                            .last()
                            .and_then(|turn| turn.configuration.clone())
                    })
                    .unwrap_or_default(),
            )
        }
    }

    fn context_estimate(
        &self,
        thread: &Thread,
        messages: &[Message],
        schemas: &[Value],
        registry: Option<&tools::Registry>,
    ) -> anyhow::Result<ContextEstimate> {
        let original = history(thread, &self.store)?;
        let logical = crate::history::logical_history(thread, &self.store)?;
        let attachments: Vec<_> = logical
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter_map(|item| match item {
                Item::UserMessage { content, .. } => Some(
                    content
                        .iter()
                        .map(|input| crate::history::uploaded_content(input, thread, &self.store))
                        .collect::<anyhow::Result<Vec<_>>>(),
                ),
                _ => None,
            })
            .collect::<anyhow::Result<_>>()?;
        let instruction = logical
            .turns
            .last()
            .filter(|turn| turn.instruction_snapshot.is_some());
        let summary = thread
            .context_checkpoint
            .as_ref()
            .map(crate::history::summary_message);
        let mut parts = vec![part(Kind::Other, "请求封套", 512)];
        for message in messages {
            let text = message.text_content();
            let cost = context::text_tokens(&text);
            let preserved = original.iter().any(|source| source == message);
            let instruction = instruction.filter(|turn| {
                message.role == "system"
                    && turn.instruction_snapshot.as_deref() == Some(text.as_str())
            });
            if let Some(turn) = instruction {
                if let Some(attribution) =
                    turn.instruction_attribution.as_ref().filter(|attribution| {
                        attribution.sha256 == format!("{:x}", Sha256::digest(text.as_bytes()))
                            && attribution
                                .parts
                                .iter()
                                .map(|part| part.estimated_tokens)
                                .sum::<u64>()
                                == cost as u64
                    })
                {
                    parts.extend(attribution.parts.iter().cloned());
                } else {
                    parts.push(part(Kind::Other, "未分类指令", cost));
                }
            } else if summary.as_ref() == Some(message) {
                parts.push(part(Kind::Summary, "压缩摘要", cost));
            } else if preserved && message.role == "tool" {
                let mut sources = logical
                    .turns
                    .iter()
                    .flat_map(|turn| &turn.items)
                    .filter_map(|item| match item {
                        Item::DynamicToolCall {
                            call_id,
                            tool,
                            success,
                            arguments,
                            ..
                        } if Some(call_id) == message.tool_call_id.as_ref() => {
                            Some((tool.as_str(), arguments, success))
                        }
                        _ => None,
                    });
                let source = sources.next();
                if sources.next().is_some() {
                    parts.push(part(Kind::Other, "无法唯一归属的工具返回", cost));
                } else if let Some((name, arguments, success)) = source {
                    if name == "skill_read"
                        && *success == Some(true)
                        && registry
                            .and_then(|registry| registry.get(name).ok())
                            .is_some_and(|tool| matches!(tool.backend, tools::Backend::Core))
                    {
                        parts.push(part(
                            Kind::Skills,
                            arguments["skill"]["id"].as_str().unwrap_or("已读取技能"),
                            cost,
                        ));
                    } else {
                        parts.push(part(Kind::ToolResults, name, cost));
                    }
                } else {
                    parts.push(part(Kind::Other, "未分类工具返回", cost));
                }
            } else if preserved && matches!(message.role.as_str(), "user" | "assistant") {
                parts.push(part(
                    Kind::Conversation,
                    if message.role == "user" {
                        "用户消息"
                    } else {
                        "助手消息"
                    },
                    cost,
                ));
            } else {
                parts.push(part(Kind::Other, "其他上下文", cost));
            }
            parts.push(part(Kind::Other, "消息封套", 16));
            for call in &message.tool_calls {
                parts.push(part(
                    Kind::Conversation,
                    "工具调用参数",
                    context::text_tokens(&context::wire_call(call).to_string()),
                ));
            }
            if let Some(value) = &message.provider_context {
                parts.push(part(
                    Kind::Other,
                    "供应商上下文",
                    context::text_tokens(&value.to_string()),
                ));
            }
            for content in &message.content {
                if !matches!(content, ContentPart::Text(_)) {
                    parts.push(part(
                        if preserved
                            && message.role == "user"
                            && attachments.contains(&message.content)
                        {
                            Kind::Attachments
                        } else if preserved && message.role == "tool" {
                            Kind::ToolResults
                        } else {
                            Kind::Other
                        },
                        "媒体",
                        4096,
                    ));
                }
            }
        }
        let mut encoded = String::from("[");
        parts.push(part(
            Kind::Other,
            "工具封套",
            context::text_tokens(&encoded),
        ));
        for (index, schema) in schemas.iter().enumerate() {
            if index > 0 {
                let before = context::text_tokens(&encoded);
                encoded.push(',');
                parts.push(part(
                    Kind::Other,
                    "工具封套",
                    context::text_tokens(&encoded) - before,
                ));
            }
            let name = schema["function"]["name"].as_str().unwrap_or("");
            let category = match registry
                .and_then(|registry| registry.get(name).ok())
                .map(|tool| tool.backend.clone())
            {
                Some(tools::Backend::Command(_)) => "CLI",
                Some(tools::Backend::Mcp(_)) => "MCP",
                Some(
                    tools::Backend::Builtin
                    | tools::Backend::Core
                    | tools::Backend::Agent
                    | tools::Backend::Coordination,
                ) => "内置",
                _ => "其他",
            };
            let before = context::text_tokens(&encoded);
            encoded.push_str(&serde_json::to_string(schema)?);
            parts.push(part(
                Kind::ToolDefinitions,
                &format!("{category} · {name}"),
                context::text_tokens(&encoded) - before,
            ));
        }
        let before = context::text_tokens(&encoded);
        encoded.push(']');
        parts.push(part(
            Kind::Other,
            "工具封套",
            context::text_tokens(&encoded) - before,
        ));
        let parts = group(parts);
        let tokens = context::request_tokens(messages, schemas)? as u64;
        anyhow::ensure!(
            parts.iter().map(|part| part.estimated_tokens).sum::<u64>() == tokens,
            "context attribution does not match request estimate"
        );
        Ok(ContextEstimate { tokens, parts })
    }

    pub(crate) async fn publish_context_usage(
        &self,
        cell: &Cell,
        messages: &[Message],
        schemas: &[Value],
        configuration: &areal_protocol::desktop::EffectiveConfig,
        model: &dyn Model,
    ) -> anyhow::Result<()> {
        let mut state = cell.state.lock().await;
        let estimate = self.context_estimate(
            &state.thread,
            messages,
            schemas,
            state
                .active
                .as_ref()
                .and_then(|active| active.registry.as_ref().ok()),
        )?;
        let basis = basis(configuration, Some(model), state.thread.turns.last());
        let active = state
            .active
            .as_mut()
            .context("active context owner missing")?;
        active.context_sequence += 1;
        active.context_usage = Some(ContextUsage::Ready {
            basis,
            budget: budget(&self.limits, model)?,
            scope: ContextScope::AssembledRequest {
                sequence: active.context_sequence,
            },
            estimate,
        });
        Ok(())
    }

    pub(crate) async fn context_usage(
        &self,
        cell: &Cell,
        thread: &Thread,
    ) -> anyhow::Result<ContextUsage> {
        let (active, configuration, model) = {
            let state = cell.state.lock().await;
            if let Some(reading) = state
                .active
                .as_ref()
                .and_then(|active| active.context_usage.clone())
            {
                return Ok(reading);
            }
            let configuration = self.context_configuration(thread, state.active.is_some());
            let model = state
                .active
                .as_ref()
                .map(|active| active.model.clone())
                .or_else(|| self.configured_model(&configuration).ok());
            (state.active.is_some(), configuration, model)
        };
        let basis = basis(&configuration, model.as_deref(), thread.turns.last());
        let Some(model) = model else {
            return Ok(ContextUsage::Unavailable {
                basis,
                budget: None,
                reason: ContextUnavailable::ModelUnavailable,
            });
        };
        let budget = budget(&self.limits, model.as_ref())?;
        if active {
            return Ok(ContextUsage::Unavailable {
                basis,
                budget: Some(budget),
                reason: ContextUnavailable::AwaitingRequest,
            });
        }
        let logical = crate::history::logical_history(thread, &self.store)?;
        if logical
            .turns
            .last()
            .is_some_and(|turn| turn.instruction_snapshot.is_some() && turn.configuration.is_none())
        {
            return Ok(ContextUsage::Unavailable {
                basis,
                budget: Some(budget),
                reason: ContextUnavailable::InstructionBasisChanged,
            });
        }
        if let Some(previous) = logical
            .turns
            .last()
            .and_then(|turn| turn.configuration.as_ref())
        {
            let mut current = self.freeze_configuration(configuration.clone());
            current.revision = previous.revision;
            let mut previous = previous.clone();
            for value in [&mut current, &mut previous] {
                value.context_window = None;
                value.parameters.context_window_tokens = None;
                if let Some(provider) = &mut value.provider {
                    provider.context_source = None;
                    provider.parameters.context_window_tokens = None;
                    for parameters in provider.model_parameters.values_mut() {
                        parameters.context_window_tokens = None;
                    }
                    provider
                        .model_parameters
                        .retain(|_, parameters| *parameters != Default::default());
                }
            }
            if current != previous {
                return Ok(ContextUsage::Unavailable {
                    basis,
                    budget: Some(budget),
                    reason: ContextUnavailable::InstructionBasisChanged,
                });
            }
        }
        let schemas = self
            .visible_tools(cell, &configuration, thread.desktop.is_some(), thread)
            .await;
        let mut messages = self.request_prefix(
            cell,
            &configuration,
            logical
                .turns
                .last()
                .and_then(|turn| turn.instruction_snapshot.as_deref()),
        );
        messages.extend(history(thread, &self.store)?);
        let registry = self.managed_registry(thread, cell.research).ok();
        let estimate = self.context_estimate(thread, &messages, &schemas, registry.as_ref())?;
        Ok(ContextUsage::Ready {
            basis,
            budget,
            scope: ContextScope::RecordedHistory,
            estimate,
        })
    }

    pub(crate) async fn session_usage(&self, thread: &Thread) -> anyhow::Result<Value> {
        let thread = self.store.hydrate(thread.clone()).await?;
        let mut usage = areal_protocol::ModelUsage::default();
        let mut generation = GenerationStats::default();
        let (mut known, mut unknown, mut partial) = (0, 0, 0);
        for turn in &thread.turns {
            if let Some(value) = &turn.usage {
                usage.add_assign(value);
                known += 1;
            } else {
                unknown += 1;
            }
            if let Some(value) = &turn.generation {
                generation.output_tokens += value.output_tokens;
                generation.duration_ms += value.duration_ms;
                generation.measured_requests += value.measured_requests;
                generation.unmeasured_requests += value.unmeasured_requests;
                generation.usage_requests += value.usage_requests;
                generation.missing_usage_requests += value.missing_usage_requests;
                if turn.usage.is_some() && value.missing_usage_requests > 0 {
                    partial += 1;
                }
            } else if turn.usage.is_some() {
                partial += 1;
            }
        }
        Ok(
            json!({"usage":(known > 0).then_some(usage),"generation":generation,"knownTurns":known,"unknownTurns":unknown,"partialTurns":partial,"scope":"ownTurns"}),
        )
    }
}
