use super::*;

impl Engine {
    // Called only at explicit user submission admission, never at queue execution.
    pub(super) fn remember_accepted_model(
        &self,
        thread: &mut Thread,
        configuration: &EffectiveConfig,
    ) -> Result<()> {
        if thread.is_read_only_side()
            || thread.parent_thread_id.is_some()
            || thread.source == "nativeTaskAgent"
            || thread.goal_owner.is_some()
            || thread.goals.goal.is_some()
            || configuration
                .profile
                .as_ref()
                .is_some_and(|p| p.workflow.is_some())
            || configuration
                .options
                .append_instructions
                .starts_with("AREAL_TASK_DRAFT_V1\n")
        {
            return Ok(());
        }
        let Some(data) = thread.desktop.as_mut() else {
            return Ok(());
        };
        let model = self.configured_model(configuration)?;
        let parameters = if configuration.model.is_none() {
            self.default_model_metadata(configuration.default_model_revision.as_deref())
                .map(|(_, defaults)| {
                    super::catalog::merge_model_parameters(
                        configuration.parameters.clone(),
                        defaults,
                    )
                })
                .unwrap_or_else(|| configuration.parameters.clone())
        } else {
            configuration.parameters.clone()
        };
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;
        data.last_accepted_model = Some(AcceptedModelSelection {
            accepted_at: timestamp.max(
                data.last_accepted_model
                    .as_ref()
                    .map_or(0, |s| s.accepted_at + 1),
            ),
            model: configuration.model.clone(),
            model_id: model.name().into(),
            reasoning_effort: parameters.reasoning_effort,
        });
        Ok(())
    }

    pub(super) async fn last_accepted_model(&self) -> Option<AcceptedModelSelection> {
        let cells: Vec<_> = self.threads.read().await.values().cloned().collect();
        let mut latest: Option<AcceptedModelSelection> = None;
        for cell in cells {
            let state = cell.state.lock().await;
            if let Some(selection) = state
                .thread
                .desktop
                .as_ref()
                .and_then(|d| d.last_accepted_model.as_ref())
                && latest
                    .as_ref()
                    .is_none_or(|previous| selection.accepted_at > previous.accepted_at)
            {
                latest = Some(selection.clone());
            }
        }
        latest
    }
}
