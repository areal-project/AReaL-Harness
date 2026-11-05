use super::*;
use crate::server::shell_subscription::Subscription;

pub(super) const METHODS: &[&str] = &["shell.subscribe", "shell.unsubscribe"];

impl Session {
    pub(super) async fn shell_request(&mut self, method: &str, params: &Value) -> Result<Value> {
        ensure!(self.gui_read, "INVALID_PARAMS");
        self.authorize(None, "observe")?;
        if method == "shell.unsubscribe" {
            ensure!(exact(params, &["subscriptionId"]), "INVALID_PARAMS");
            let id = text(params, "subscriptionId")?;
            let closed = self.shell.as_ref().is_some_and(|sub| sub.id() == id);
            if closed {
                self.shell = None;
            }
            return Ok(json!({"closed":closed}));
        }
        ensure!(
            method == "shell.subscribe" && exact(params, &[]),
            "INVALID_PARAMS"
        );
        let allowed = self.grant["projectIds"]
            .as_array()
            .context("GRANT_CHANGED")?;
        let projects = self
            .bindings()?
            .into_iter()
            .filter(|(_, alias)| allowed.iter().any(|id| id == alias))
            .map(|(id, _)| id)
            .collect();
        let outcome = Subscription::open_remote(
            &self.host,
            &self.connection,
            &self.generation,
            projects,
            &self.source_id,
        )
        .await;
        self.authorize(None, "observe")?;
        let (sub, value) = outcome?;
        self.shell = Some(sub);
        Ok(value)
    }
    pub(super) async fn shell_event(&mut self) -> Result<Option<Value>> {
        self.authorize(None, "observe")?;
        let value = match &mut self.shell {
            Some(sub) => sub.refresh(&self.host).await,
            None => Ok(None),
        };
        self.authorize(None, "observe")?;
        value
    }
    pub(super) fn native_alias(&self, canonical: &str) -> Result<String> {
        self.bindings()?
            .into_iter()
            .find(|(id, _)| id == canonical)
            .map(|(_, alias)| alias)
            .context("FORBIDDEN")
    }
}
