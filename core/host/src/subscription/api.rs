use super::*;
use serde_json::json;

impl SourceSubscription {
    pub(crate) fn stored_accounts(migration: &Migration, source: &str) -> Result<Value> {
        Ok(SourceAccounts::read(&migration.vault, source, migration)?.public())
    }
    pub(crate) fn source_id(&self) -> &str {
        &self.source
    }
    pub(crate) fn account_epoch(&self) -> u64 {
        self.state.borrow().epoch
    }
    pub(crate) fn snapshot(&self) -> network::Result<Value> {
        let accounts = self.accounts()?;
        let runtime = self.state.borrow();
        let selected = accounts.directory.as_ref().map(AccountDirectory::active);
        let authenticated = selected.is_some_and(|record| record.authenticated());
        let failure = runtime.failure.as_ref();
        let state = if runtime.pending.is_some()
            && failure.is_some_and(|failure| failure.state() == "storage_locked")
        {
            "storage_locked"
        } else if let Some(failure) = failure {
            failure.state()
        } else if runtime.flight.is_some() || (authenticated && runtime.catalog.expires == 0) {
            "refreshing"
        } else if authenticated {
            "ready"
        } else if selected.is_some_and(|record| record.requires_auth()) {
            "reauth_required"
        } else {
            "signed_out"
        };
        let mut value = accounts.public();
        value.as_object_mut().unwrap().extend(json!({"accountEpoch":runtime.epoch,"authenticated":authenticated,"state":state,"availability":if state=="ready" && !runtime.catalog.models.is_empty(){"available"}else if authenticated{"checking"}else{"unavailable"},"refreshing":runtime.flight.is_some(),"email":selected.and_then(|record|record.email()),"planType":null,"models":runtime.catalog.models,"modelError":failure.filter(|failure|failure.phase=="catalog").map(Failure::message),"diagnostic":failure.map(Failure::diagnostic),"login":self.login_public(),"error":*self.notice.borrow(),"billing":"subscription","catalog":{"source":"account","fresh":runtime.catalog.expires>now_ms(),"sessionRevision":runtime.epoch,"fetchedAt":runtime.catalog.expires.checked_sub(30_000),"overrides":false},"endpoint":self.listener.borrow().as_ref().map(|listener|listener.endpoint.as_str())}).as_object().unwrap().clone());
        Ok(value)
    }
    pub(crate) async fn start(self: &Rc<Self>) -> network::Result<()> {
        self.start_with_port_request(None).await
    }
    pub(crate) async fn start_with_port_request(
        self: &Rc<Self>,
        request: Option<&str>,
    ) -> network::Result<()> {
        if self.listener.borrow().is_some() {
            return Ok(());
        }
        let listener = transport::listen(self.clone(), request).await?;
        *self.listener.borrow_mut() = Some(listener);
        Ok(())
    }
    pub(crate) fn bound_port(&self) -> Option<u16> {
        self.listener
            .borrow()
            .as_ref()
            .map(|listener| listener.port)
    }
    pub(crate) async fn refresh_catalog(self: &Rc<Self>, force: bool) -> network::Result<()> {
        if !self
            .accounts()?
            .directory
            .as_ref()
            .is_some_and(|directory| directory.active().authenticated())
        {
            return Ok(());
        }
        self.discover(force).await.map(|_| ())
    }
    pub(crate) async fn sign_out(&self) -> network::Result<()> {
        *self.notice.borrow_mut() = None;
        if let Some(record) = self.logout()? {
            let oauth = self.oauth.borrow().clone();
            if oauth.revoke(&record, &self.lifetime).await.is_err() {
                *self.notice.borrow_mut() = Some(
                    "已退出本地账号，但远端授权撤销未确认。可在 ChatGPT 设置中断开应用。".into(),
                );
            }
        }
        Ok(())
    }
    pub(crate) fn forget_registration(&self) -> network::Result<()> {
        self.commit_pending()?;
        let accounts = self.accounts()?;
        let Some(mut directory) = accounts.directory else {
            return Ok(());
        };
        directory.replace_active(directory.active().forget().map_err(Failure::storage)?);
        self.migration
            .vault
            .replace_subscription_account(
                &self.source,
                &uuid::Uuid::new_v4().to_string(),
                accounts.revision.0,
                directory.encode(),
                &self.migration,
            )
            .map_err(Failure::storage)?;
        self.changed();
        Ok(())
    }
    pub(crate) async fn select_account(self: &Rc<Self>, id: &str) -> network::Result<()> {
        let flight = self.state.borrow().flight.clone();
        if let Some(mut flight) = flight {
            while flight.borrow().is_none() {
                flight
                    .changed()
                    .await
                    .map_err(|_| Failure::new("cancelled", "account"))?;
            }
        }
        self.commit_pending()?;
        let accounts = self.accounts()?;
        let mut directory = accounts
            .directory
            .ok_or_else(|| Failure::new("credential_missing", "account"))?;
        if directory.active_id == id {
            directory
                .active()
                .usable_grant()
                .map_err(Failure::storage)?;
            return Ok(());
        }
        let record = directory
            .record(id)
            .ok_or_else(|| Failure::new("account_changed", "account"))?
            .clone();
        let epoch = self.account_epoch();
        let expires = record.grant().map_err(Failure::storage)?.expires;
        let previous_refresh = record.grant().map_err(Failure::storage)?.refresh.to_owned();
        let previous_active = directory.active_id.clone();
        let record = if expires <= now_ms() as f64 + 60_000.0 {
            let oauth = self.oauth.borrow().clone();
            oauth.refresh(&record).await?
        } else {
            record
        };
        record.usable_grant().map_err(Failure::storage)?;
        self.check_epoch(epoch)?;
        directory.select(id).map_err(Failure::storage)?;
        directory.replace_active(record);
        self.state.borrow_mut().pending = Some(PendingRotation {
            account: id.into(),
            previous_active,
            change_epoch: true,
            epoch,
            expected_revision: accounts.revision.0,
            previous_refresh,
            directory,
            request_id: uuid::Uuid::new_v4().to_string(),
            terminal: None,
        });
        self.commit_pending()
    }
    pub(crate) fn network_input(&self, input: network::NetworkInput) -> network::Result<()> {
        let network = Network::new(input)?;
        *self.oauth.borrow_mut() = Rc::new(oauth::OAuth::new(network.clone()));
        *self.network.borrow_mut() = network;
        Ok(())
    }
}
