use crate::{PluginList, Store};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentLink {
    pub source: PathBuf,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DevelopmentRefresh {
    pub changed: bool,
    pub errors: std::collections::BTreeMap<String, String>,
}
impl Store {
    pub fn development_link(
        &self,
        id: &str,
        expected_revision: u64,
        expected_digest: &str,
    ) -> Result<PluginList> {
        self.transact(expected_revision, |state| {
            let installed = state.installed.get(id).context("plugin not installed")?;
            ensure!(
                installed.review_digest() == expected_digest,
                "installed plugin digest changed"
            );
            let (_, candidates, _) = self.catalogs(state);
            let candidate = candidates
                .iter()
                .find(|candidate| candidate.id == id)
                .context("plugin local source unavailable")?;
            ensure!(
                candidate.source_kind.as_deref() == Some("local")
                    && candidate.source == installed.source,
                "development links require the installed local catalog source"
            );
            state.development_links.insert(
                id.into(),
                DevelopmentLink {
                    source: candidate.source.clone(),
                },
            );
            Ok(())
        })?;
        self.list()
    }
    pub fn development_unlink(&self, id: &str, expected_revision: u64) -> Result<PluginList> {
        self.transact(expected_revision, |state| {
            state.development_links.remove(id);
            Ok(())
        })?;
        self.list()
    }
    pub fn refresh_development_links(&self) -> Result<DevelopmentRefresh> {
        let links = self.state()?.development_links;
        let mut report = DevelopmentRefresh::default();
        for (id, link) in links {
            match self.refresh_development_link(&id, &link) {
                Ok(changed) => report.changed |= changed,
                Err(_) => {
                    report
                        .errors
                        .insert(id, "developmentSourceRefreshFailed".into());
                }
            }
        }
        Ok(report)
    }
    fn refresh_development_link(&self, id: &str, link: &DevelopmentLink) -> Result<bool> {
        let state = self.state()?;
        let Some(current_link) = state.development_links.get(id) else {
            return Ok(false);
        };
        if current_link.source != link.source {
            return Ok(false);
        }
        let installed = state
            .installed
            .get(id)
            .context("linked plugin not installed")?;
        let (_, candidates, _) = self.catalogs(&state);
        let candidate = candidates
            .into_iter()
            .find(|candidate| candidate.id == id)
            .context("development source unavailable")?;
        ensure!(
            candidate.source_kind.as_deref() == Some("local") && candidate.source == link.source,
            "development source identity changed"
        );
        if candidate.review_digest() == installed.review_digest() {
            return Ok(false);
        }
        match self.install_in_scope(
            id,
            None,
            state.revision,
            &candidate.source,
            candidate.review_digest(),
        ) {
            Ok(_) => Ok(true),
            Err(error)
                if error
                    .downcast_ref::<crate::StoreError>()
                    .is_some_and(|error| matches!(error, crate::StoreError::Conflict { .. })) =>
            {
                let latest = self.state()?;
                if latest
                    .installed
                    .get(id)
                    .is_some_and(|installed| installed.review_digest() == candidate.review_digest())
                {
                    return Ok(false);
                }
                Err(error)
            }
            Err(error) => Err(error),
        }
    }
}
