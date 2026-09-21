use super::*;

const SUMMARY_LIMIT: usize = 16 * 1024;

pub(crate) fn message_bytes(messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|message| {
            message.text_content().len()
                + message
                    .content
                    .iter()
                    .map(|p| match p {
                        ContentPart::Image { .. } => 16 * 1024,
                        ContentPart::Audio { .. } | ContentPart::File { .. } => 32 * 1024,
                        ContentPart::Text(_) => 0,
                    })
                    .sum::<usize>()
                + message
                    .tool_calls
                    .iter()
                    .map(|call| call.to_string().len())
                    .sum::<usize>()
                + message
                    .provider_context
                    .as_ref()
                    .map_or(0, |value| value.to_string().len())
                + 64
        })
        .sum()
}

// Conservative estimate, not a tokenizer. Calibrate upward against actual input
// usage; never assume one byte equals one token or lower the estimate on cache hits.
pub(crate) fn text_tokens(text: &str) -> usize {
    let ascii = text.bytes().filter(u8::is_ascii).count();
    ascii.div_ceil(3) + text.chars().filter(|c| !c.is_ascii()).count() * 2
}
pub(crate) fn estimate_tokens(messages: &[Message]) -> usize {
    messages
        .iter()
        .map(|m| {
            text_tokens(&m.text_content())
                + 16
                + m.tool_calls
                    .iter()
                    .map(|v| text_tokens(&v.to_string()))
                    .sum::<usize>()
                + m.provider_context
                    .as_ref()
                    .map_or(0, |v| text_tokens(&v.to_string()))
                + m.content
                    .iter()
                    .map(|p| {
                        if matches!(p, ContentPart::Text(_)) {
                            0
                        } else {
                            4096
                        }
                    })
                    .sum::<usize>()
        })
        .sum()
}
fn calibrated(estimate: usize, previous: Option<(usize, u64)>) -> usize {
    previous
        .filter(|(n, _)| *n > 0)
        .map_or(estimate, |(n, actual)| {
            estimate.max(
                (estimate as u128 * actual as u128)
                    .div_ceil(n as u128)
                    .min(usize::MAX as u128) as usize,
            )
        })
}
fn valid_summary(summary: &str) -> bool {
    let text = summary.trim();
    let lower = text.to_ascii_lowercase();
    !text.is_empty()
        && !lower.contains("<tool_call")
        && !lower.contains("<function=")
        && !serde_json::from_str::<Value>(text)
            .is_ok_and(|value| value.get("name").is_some() || value.get("tool_calls").is_some())
}

impl Engine {
    pub(crate) async fn project_instructions(
        self: &Arc<Self>,
        cell: &Arc<Cell>,
    ) -> anyhow::Result<Option<String>> {
        if self.runtime.is_none() && cell.state.lock().await.thread.desktop.is_none() {
            return Ok(None);
        }
        let mut instructions = include_str!("instructions.md").to_owned();
        let configuration = cell
            .state
            .lock()
            .await
            .thread
            .turns
            .last()
            .and_then(|t| t.configuration.clone());
        if let Some(config) = configuration {
            if let Some(prompt) = &config.options.system_prompt {
                instructions = prompt.clone();
            }
            if let Some(profile) = config.profile {
                instructions.push_str("\n\nProduct mode instructions (subject to user instructions and deployment permissions):\n");
                instructions.push_str(&profile.instructions);
                instructions.push_str(&format!(
                    "\nAvailable skills (read using skill_read): {}",
                    serde_json::to_string(&self.skill_summaries(
                        config.selected_skills.as_ref().unwrap_or(&profile.skills)
                    ))?
                ));
            }
            instructions.push_str(&config.instructions);
            instructions.push_str("\nClient appended instructions:\n");
            instructions.push_str(&config.options.append_instructions);
        }
        if cell.research {
            instructions.push_str(&format!("\nYou are a bounded research worker. Your deliverable is an answer to the assigned subquestion, not a complete solution of the original issue. The repository is read-only. Write reproductions, logs and test output only under {} (also TMPDIR). Do not edit source or tests, install dependencies, delegate further, or leave background work. Inspect the assigned question and run focused checks when useful. Once you have enough evidence, report it instead of expanding into additional investigations or broad test suites. If a check needs repository writes, report that limitation or run a focused reproduction in your scratch. Return concise evidence within 2500 UTF-8 bytes with file paths/lines, observed commands/results, uncertainties and a recommended change. Reserve enough of your request budget to write this report; incomplete evidence with explicit limitations is useful. Parent performs integration and final verification; your conclusions are advisory.", self.command_scratch(cell).context("research scratch missing")?.display()));
        } else if self.extensions.agents.is_some() {
            instructions.push('\n');
            instructions.push_str(include_str!("agent-instructions.md"));
        }
        let Some(runtime) = &self.runtime else {
            return Ok(Some(instructions));
        };
        let path = runtime.workspace.join("AGENTS.md");
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Some(instructions));
            }
            Err(error) => return Err(error).context("cannot inspect project instructions"),
            Ok(metadata) => anyhow::ensure!(
                metadata.is_file() && metadata.len() <= 32 * 1024,
                "AGENTS.md must be a regular file no larger than 32 KiB"
            ),
        }
        // Read through the Runtime's descriptor-based file provider. The owned
        // task ensures cancellation cannot abandon a newly created Scope.
        let (sent, received) = tokio::sync::oneshot::channel();
        let engine = self.clone();
        let owned_cell = cell.clone();
        {
            let state = cell.state.lock().await;
            state.active.as_ref().unwrap().tools.spawn(async move {
                let result = engine.read_project_instructions(&owned_cell).await;
                let _ = sent.send(result);
            });
        }
        let content = received.await??;
        instructions.push_str("\n\nProject instructions from workspace AGENTS.md (subordinate to the user's request and deployment permissions):\n");
        instructions.push_str(&content);
        Ok(Some(instructions))
    }

    async fn read_project_instructions(&self, cell: &Cell) -> anyhow::Result<String> {
        use areal_runtime_protocol as rt;
        use base64::Engine as _;
        let client = &self.runtime.as_ref().unwrap().client;
        let task = cell.state.lock().await.thread.id.clone();
        let scope = client
            .create_scope(rt::CreateScope {
                operation_id: client.operation_id(),
                parent_scope_id: client.info().root_scope_id.clone(),
                owner: rt::Owner {
                    task_id: task,
                    plugin_instance_id: None,
                },
                permissions: self.active_permissions(cell).await,
                limits: rt::LimitRequest::default(),
            })
            .await?;
        cell.state.lock().await.active.as_mut().unwrap().scope = Some(scope.scope_id.clone());
        let value = client
            .filesystem(rt::FileRequest {
                operation_id: client.operation_id(),
                scope_id: scope.scope_id,
                command: rt::FileCommand::Read {
                    path: "workspace://repo/AGENTS.md".into(),
                    offset: 0,
                    max_bytes: 32 * 1024,
                },
            })
            .await?;
        anyhow::ensure!(
            value["eof"] == true,
            "AGENTS.md grew beyond the instruction budget"
        );
        let bytes = base64::engine::general_purpose::STANDARD.decode(
            value["dataBase64"]
                .as_str()
                .context("invalid project instruction result")?,
        )?;
        String::from_utf8(bytes).context("AGENTS.md must be UTF-8")
    }

    pub(crate) async fn compact_context(
        &self,
        cell: &Cell,
        cancel: &CancellationToken,
        overhead_tokens: usize,
        previous_usage: Option<(usize, u64)>,
        force: bool,
    ) -> anyhow::Result<()> {
        let snapshot = cell.state.lock().await.thread.clone();
        let model = self.configured_model(
            &snapshot
                .turns
                .last()
                .and_then(|t| t.configuration.clone())
                .unwrap_or_default(),
        )?;
        let messages = history(&snapshot, &self.store)?;
        let before_bytes = message_bytes(&messages);
        let estimated_tokens =
            calibrated(estimate_tokens(&messages) + overhead_tokens, previous_usage);
        let token_trigger = self.limits.context_window_tokens > 0
            && estimated_tokens
                >= self
                    .limits
                    .context_window_tokens
                    .saturating_sub(self.limits.context_output_reserve_tokens);
        if !force && before_bytes <= self.limits.context_window_bytes && !token_trigger {
            return Ok(());
        }

        let items: Vec<_> = snapshot.turns.iter().flat_map(|turn| &turn.items).collect();
        let previous = snapshot
            .context_checkpoint
            .as_ref()
            .and_then(|checkpoint| {
                items
                    .iter()
                    .position(|item| item.id() == checkpoint.through_item_id)
            })
            .map_or(0, |index| index + 1);
        let mut recent_bytes = 0;
        let mut cut = None;
        // Cut only before a model round or a new user message. A round's opaque
        // reasoning, function calls and results always remain in the same group.
        for index in (previous..items.len()).rev() {
            if matches!(items[index], Item::ModelContext { value, .. } if value["type"] == "chat_reasoning")
            {
                continue;
            }
            recent_bytes += serde_json::to_vec(items[index])?.len();
            if recent_bytes >= self.limits.context_recent_bytes
                && index > previous
                && matches!(
                    items[index],
                    Item::AgentMessage { .. } | Item::UserMessage { .. }
                )
            {
                cut = Some(index);
                break;
            }
        }
        // A single oversized round cannot be split into invalid tool history.
        let Some(cut) = cut else {
            return Ok(());
        };
        let boundary = items[cut - 1].id().to_owned();
        let mut prefix = snapshot.clone();
        let mut left = cut;
        for turn in &mut prefix.turns {
            let take = left.min(turn.items.len());
            turn.items.truncate(take);
            left -= take;
        }
        let mut input = history(&prefix, &self.store)?;
        input.insert(
            0,
            Message::text("system", include_str!("summary-instructions.md")),
        );
        input.push(Message::text(
            "user",
            "Produce the continuation summary now.",
        ));
        let started = tokio::time::Instant::now();
        let mut usage = areal_protocol::ModelUsage::default();
        let mut accepted = None;
        for attempt in 0..2 {
            let mut summary = String::new();
            let mut attempt_usage = areal_protocol::ModelUsage::default();
            let mut rejected_tools = Vec::new();
            let response: anyhow::Result<()> = async {
                self.reserve_agent_model_request(cell)?;
                let mut stream = tokio::select! {
                    _ = cancel.cancelled() => anyhow::bail!("cancelled"),
                    result = tokio::time::timeout(self.limits.stream_idle_timeout, model::REQUEST_OWNER.scope((snapshot.id.clone(), snapshot.turns.last().map_or_else(String::new, |t| t.id.clone())), model.chat_for(input.clone(), Vec::new(), model::RequestPurpose::Summary))) => result??,
                };
                loop {
                    let event = tokio::select! {
                        _ = cancel.cancelled() => anyhow::bail!("cancelled"),
                        result = tokio::time::timeout(self.limits.stream_idle_timeout, stream.next()) => result.context("compaction stream idle timeout")?,
                    };
                    let Some(event) = event else { break; };
                    match event? {
                        ModelEvent::TextDelta(text) => {
                            // Archive a bounded response even when rejecting its size.
                            summary.push_str(tools::prefix(&text, SUMMARY_LIMIT + 1 - summary.len()));
                            anyhow::ensure!(summary.len() <= SUMMARY_LIMIT, "context summary exceeds 16 KiB");
                        }
                        ModelEvent::Usage(value) => attempt_usage.add_assign(&value),
                        ModelEvent::ToolCall(call) => {
                            rejected_tools.push(json!({"name":call.name,"arguments":tools::prefix(&call.arguments,4096)}));
                            anyhow::bail!("context summary must be text without tools");
                        }
                        ModelEvent::Activity | ModelEvent::ProviderContext(_) => {}
                        ModelEvent::Binary { .. } => anyhow::bail!("context summary must be text"),
                    }
                }
                anyhow::ensure!(valid_summary(&summary), "model returned an empty or tool-shaped context summary");
                Ok(())
            }.await;
            usage.add_assign(&attempt_usage);
            self.store.save_audit(json!({"kind":"contextSummary","threadId":snapshot.id,"attempt":attempt+1,"beforeBytes":before_bytes,"estimatedInputTokens":estimated_tokens,"tokenWindow":self.limits.context_window_tokens,"outputReserveTokens":self.limits.context_output_reserve_tokens,"response":summary,"rejectedTools":rejected_tools,"usage":attempt_usage,"error":response.as_ref().err().map(|e|e.to_string()),"cancelled":cancel.is_cancelled()})).await?;
            anyhow::ensure!(!cancel.is_cancelled(), "cancelled");
            if response.is_ok() {
                accepted = Some(summary);
                break;
            }
            input.push(Message::text("user", "The summary was rejected. Return plain factual text only, without tool calls or markup. Use fewer than 1800 words and 12000 UTF-8 bytes. Keep unfinished work and verification status explicit."));
        }
        let summary = accepted
            .unwrap_or_else(|| retained_evidence(&prefix, SUMMARY_LIMIT.min(before_bytes / 3)));
        let mut state = cell.state.lock().await;
        let mut candidate = state.thread.clone();
        let mut cumulative_usage = snapshot
            .context_checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.usage.clone())
            .unwrap_or_default();
        cumulative_usage.add_assign(&usage);
        candidate.context_checkpoint = Some(areal_protocol::ContextCheckpoint {
            through_item_id: boundary,
            summary,
            total_duration_ms: started.elapsed().as_millis() as u64
                + snapshot
                    .context_checkpoint
                    .as_ref()
                    .map_or(0, |checkpoint| checkpoint.total_duration_ms),
            usage: cumulative_usage,
            compactions: snapshot
                .context_checkpoint
                .as_ref()
                .map_or(1, |checkpoint| checkpoint.compactions + 1),
        });
        candidate
            .turns
            .last_mut()
            .unwrap()
            .usage
            .get_or_insert_with(Default::default)
            .add_assign(&usage);
        let after_bytes = message_bytes(&history(&candidate, &self.store)?);
        anyhow::ensure!(
            after_bytes < before_bytes,
            "context compaction did not reduce input size"
        );
        self.persist(&candidate).await?;
        state.thread = candidate;
        cell.emit("areal/context/compacted", json!({"threadId":state.thread.id,"beforeBytes":before_bytes,"afterBytes":after_bytes,"durationMs":started.elapsed().as_millis() as u64,"usage":usage}));
        tracing::info!(
            before_bytes,
            after_bytes,
            duration_ms = started.elapsed().as_millis() as u64,
            "model context compacted"
        );
        Ok(())
    }
}

// A failed summarizer cannot invent a successful narrative. Retain labeled raw
// evidence, with the original user task still replayed verbatim by history().
fn retained_evidence(thread: &Thread, budget: usize) -> String {
    let mut result = String::from(
        "DEGRADED CONTEXT: summary generation failed. Older details were omitted; the full event archive is retained. Reinspect files and rerun necessary checks before claiming completion. Do not replay unconfirmed operations. Recent evidence follows (excerpts, not a completeness claim).\n",
    );
    if let Some(checkpoint) = &thread.context_checkpoint {
        result.push_str("Previous checkpoint excerpt: ");
        result.push_str(tools::prefix(&checkpoint.summary, budget / 4));
        result.push('\n');
    }
    let mut excerpts = Vec::new();
    let mut used = result.len();
    for item in thread.turns.iter().rev().flat_map(|t| t.items.iter().rev()) {
        let evidence = match item {
            Item::DynamicToolCall {
                tool,
                arguments,
                success,
                content_items,
                ..
            } => format!(
                "Tool {tool}; args={}; success={success:?}; result={}\n",
                tools::prefix(&arguments.to_string(), 512),
                tools::prefix(
                    &serde_json::to_string(content_items).unwrap_or_default(),
                    768
                )
            ),
            Item::UserMessage { content, .. } => format!(
                "User: {}\n",
                tools::prefix(
                    &content
                        .iter()
                        .map(Input::as_text)
                        .collect::<Vec<_>>()
                        .join("\n"),
                    1024
                )
            ),
            Item::AgentMessage { text, .. } => {
                format!("Assistant claim (verify): {}\n", tools::prefix(text, 512))
            }
            _ => continue,
        };
        if used + evidence.len() > budget {
            break;
        }
        used += evidence.len();
        excerpts.push(evidence);
    }
    for excerpt in excerpts.into_iter().rev() {
        result.push_str(&excerpt);
    }
    result
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn usage_only_calibrates_upward_and_tool_shaped_summaries_are_rejected() {
        assert_eq!(calibrated(1000, Some((500, 1000))), 2000);
        assert_eq!(calibrated(1000, Some((500, 100))), 1000);
        assert_eq!(calibrated(1000, Some((0, 100))), 1000);
        for bad in [
            "",
            "<tool_call id='x'>read</tool_call>",
            "<function=run_command>",
            "{ \"name\" : \"read_file\" }",
        ] {
            assert!(!valid_summary(bad));
        }
        assert!(valid_summary(
            "Observed: foo(None) still fails. Hypothesis: fix the wrapper. Next: rerun that assertion."
        ));
    }
}
