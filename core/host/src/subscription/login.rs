use super::*;
use futures_util::future::LocalBoxFuture;
use serde_json::json;

pub(super) struct Login {
    id: String,
    target: String,
    epoch: u64,
    cancel: CancellationToken,
    url: String,
    completion: watch::Receiver<Option<network::Result<account::AccountRecord>>>,
}
pub(crate) struct Authorization {
    pub(crate) id: String,
    pub(crate) completion: LocalBoxFuture<'static, network::Result<account::AccountRecord>>,
}
impl SourceSubscription {
    pub(crate) async fn begin_login(
        self: &Rc<Self>,
        target: &Value,
    ) -> network::Result<Authorization> {
        use futures_util::FutureExt;
        if self.login.borrow().is_none() {
            let accounts = self.accounts()?;
            let mut directory=match accounts.directory {Some(directory)=>directory,None=>AccountDirectory::decode(json!({"kind":"registration","payload":{"hostId":format!("urn:uuid:{}",uuid::Uuid::new_v4())}})).map_err(Failure::storage)?};
            let id = match target["kind"].as_str() {
                Some("newAccount") => directory.add_registration().map_err(Failure::storage)?,
                Some("saved") => target["accountId"]
                    .as_str()
                    .ok_or_else(|| Failure::new("account_changed", "account"))?
                    .to_owned(),
                _ => directory.active_id.clone(),
            };
            let record = directory
                .record(&id)
                .ok_or_else(|| Failure::new("account_changed", "account"))?
                .clone();
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
            let cancel = self.lifetime.child_token();
            let oauth = self.oauth.borrow().clone();
            let exchange = oauth.begin(record, cancel.clone()).await?;
            let (sender, completion) = watch::channel(None);
            *self.login.borrow_mut() = Some(Login {
                id: uuid::Uuid::new_v4().to_string(),
                target: id,
                epoch: self.account_epoch(),
                cancel,
                url: exchange.url,
                completion,
            });
            self.track(tokio::task::spawn_local(async move {
                sender.send_replace(Some(exchange.complete.await));
            }));
        }
        let login = self.login.borrow();
        let login = login.as_ref().unwrap();
        let id = login.id.clone();
        let mut completion = login.completion.clone();
        Ok(Authorization {
            id,
            completion: async move {
                loop {
                    if let Some(result) = completion.borrow().clone() {
                        return result;
                    }
                    completion
                        .changed()
                        .await
                        .map_err(|_| Failure::new("cancelled", "sign_in"))?;
                }
            }
            .boxed_local(),
        })
    }
    pub(crate) fn cancel_attempt(&self, id: &str) -> network::Result<()> {
        if self
            .login
            .borrow()
            .as_ref()
            .is_some_and(|login| login.id != id)
        {
            return Err(Failure::new("account_changed", "sign_in"));
        }
        self.cancel_login();
        Ok(())
    }
    pub(crate) fn cancel_login(&self) {
        if let Some(login) = self.login.borrow_mut().take() {
            login.cancel.cancel();
        }
    }
    pub(crate) fn finish_login(
        &self,
        id: &str,
        record: account::AccountRecord,
        activate: bool,
    ) -> network::Result<()> {
        let Some((target, epoch)) = self
            .login
            .borrow()
            .as_ref()
            .filter(|login| login.id == id)
            .map(|login| (login.target.clone(), login.epoch))
        else {
            return Ok(());
        };
        let accounts = self.accounts()?;
        let mut directory = accounts
            .directory
            .ok_or_else(|| Failure::new("account_changed", "account"))?;
        let same = directory.active_id == target;
        let active = activate && epoch == self.account_epoch();
        directory
            .replace(&target, record)
            .map_err(Failure::storage)?;
        if active {
            directory.select(&target).map_err(Failure::storage)?;
        }
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
        self.login.borrow_mut().take();
        if same || active {
            self.state.borrow_mut().pending = None;
            self.state.borrow_mut().failure = None;
            self.changed();
        }
        Ok(())
    }
    pub(crate) fn login_failed(&self, id: &str, failure: &Failure) {
        if self
            .login
            .borrow()
            .as_ref()
            .is_some_and(|login| login.id == id)
        {
            self.login.borrow_mut().take();
            if failure.code != "cancelled" {
                self.state.borrow_mut().failure = Some(failure.clone());
            }
        }
    }
    pub(super) fn login_public(&self) -> Value {
        self.login.borrow().as_ref().map_or(
            Value::Null,
            |login| json!({"loginId":login.id,"authUrl":login.url}),
        )
    }
    pub(crate) async fn probe(&self, model: &str) -> network::Result<Value> {
        let endpoint = self
            .listener
            .borrow()
            .as_ref()
            .map(|listener| listener.endpoint.clone())
            .ok_or_else(|| Failure::new("network_error", "transport"))?;
        let (_, transport) = self
            .migration
            .vault
            .subscription_transport(&self.source, &self.migration)
            .map_err(Failure::storage)?;
        let token = transport["token"]
            .as_str()
            .ok_or_else(|| Failure::new("credential_invalid", "transport"))?;
        let response=reqwest::Client::builder().no_proxy().build().map_err(|_|Failure::new("network_error","transport"))?.post(endpoint).bearer_auth(token).timeout(std::time::Duration::from_secs(30)).json(&json!({"model":model,"stream":true,"input":[{"role":"user","content":"Reply with OK."}]})).send().await.map_err(|_|Failure::new("network_error","transport"))?;
        if !response.status().is_success() {
            return Err(network::response_error(response, "admission", &[token]).await);
        }
        let bytes = network::bounded(response, 1024 * 1024, "transport").await?;
        if !bytes
            .split(|byte| *byte == b'\n')
            .filter_map(|line| line.strip_prefix(b"data:"))
            .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
            .any(|event| {
                event["type"] == "response.completed" && event["response"]["status"] == "completed"
            })
        {
            return Err(Failure::new("invalid_response", "transport"));
        }
        Ok(json!({"state":"connected"}))
    }
}
