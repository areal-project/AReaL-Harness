pub(crate) mod account;
mod api;
mod login;
#[cfg(test)]
mod tests;

use crate::{migration::Migration, vault::Vault};
use account::AccountDirectory;
use anyhow::Result;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VaultRevision(u64);

struct SourceAccounts {
    revision: VaultRevision,
    directory: Option<AccountDirectory>,
}

impl SourceAccounts {
    fn read(vault: &Vault, source: &str, migration: &Migration) -> Result<Self> {
        let (revision, value) = vault.subscription_account(source, migration)?;
        Ok(Self {
            revision: VaultRevision(revision),
            directory: if value.is_null() {
                None
            } else {
                Some(AccountDirectory::decode(value)?)
            },
        })
    }

    fn public(&self) -> Value {
        self.directory.as_ref().map_or_else(
            || serde_json::json!({"activeAccountId":null,"accounts":[]}),
            AccountDirectory::public,
        )
    }
}

mod adapters;
mod affinity;
pub(crate) mod network;
mod oauth;
#[cfg(test)]
mod stream_tests;
mod transport;

use network::{Failure, Network, now_ms};
use std::{cell::RefCell, rc::Rc};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct AccessToken(String);
#[derive(Clone)]
struct PendingRotation {
    account: String,
    previous_active: String,
    change_epoch: bool,
    epoch: u64,
    expected_revision: u64,
    previous_refresh: String,
    directory: AccountDirectory,
    request_id: String,
    terminal: Option<Failure>,
}
struct Runtime {
    epoch: u64,
    epoch_cancel: CancellationToken,
    pending: Option<PendingRotation>,
    flight: Option<watch::Receiver<Option<network::Result<AccessToken>>>>,
    failure: Option<Failure>,
    catalog: transport::Catalog,
    affinity: affinity::Affinity,
}
pub(crate) struct SourceSubscription {
    migration: Rc<Migration>,
    source: String,
    network: RefCell<Network>,
    oauth: RefCell<Rc<oauth::OAuth>>,
    state: RefCell<Runtime>,
    lifetime: CancellationToken,
    tasks: RefCell<Vec<JoinHandle<()>>>,
    pub(crate) command_gate: tokio::sync::Mutex<()>,
    listener: RefCell<Option<transport::Listener>>,
    login: RefCell<Option<login::Login>>,
    notice: RefCell<Option<String>>,
}
impl SourceSubscription {
    pub(crate) fn load(
        migration: Rc<Migration>,
        source: String,
        network: Network,
    ) -> network::Result<Rc<Self>> {
        SourceAccounts::read(&migration.vault, &source, &migration).map_err(Failure::storage)?;
        Ok(Rc::new(Self {
            migration,
            source,
            oauth: RefCell::new(Rc::new(oauth::OAuth::new(network.clone()))),
            network: RefCell::new(network),
            state: RefCell::new(Runtime {
                epoch: 0,
                epoch_cancel: CancellationToken::new(),
                pending: None,
                flight: None,
                failure: None,
                catalog: transport::Catalog::default(),
                affinity: affinity::Affinity::default(),
            }),
            lifetime: CancellationToken::new(),
            tasks: RefCell::new(Vec::new()),
            command_gate: tokio::sync::Mutex::new(()),
            listener: RefCell::new(None),
            login: RefCell::new(None),
            notice: RefCell::new(None),
        }))
    }
    fn track(&self, task: JoinHandle<()>) {
        let mut tasks = self.tasks.borrow_mut();
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }
    fn epoch(&self) -> (u64, CancellationToken) {
        let state = self.state.borrow();
        (state.epoch, state.epoch_cancel.clone())
    }
    fn check_epoch(&self, epoch: u64) -> network::Result<()> {
        if self.lifetime.is_cancelled() || self.state.borrow().epoch != epoch {
            return Err(Failure::new("account_changed", "account"));
        }
        Ok(())
    }
    fn changed(&self) {
        let mut state = self.state.borrow_mut();
        state.epoch += 1;
        state.epoch_cancel.cancel();
        state.epoch_cancel = CancellationToken::new();
        state.flight = None;
        state.catalog = transport::Catalog::default();
        state.affinity.clear();
    }
    fn accounts(&self) -> network::Result<SourceAccounts> {
        SourceAccounts::read(&self.migration.vault, &self.source, &self.migration)
            .map_err(Failure::storage)
    }
    fn commit_pending(&self) -> network::Result<()> {
        let Some(mut pending) = self.state.borrow().pending.clone() else {
            return Ok(());
        };
        self.check_epoch(pending.epoch)?;
        let receipt = self
            .migration
            .vault
            .operation(&pending.request_id, &self.migration)
            .map_err(Failure::storage)?;
        if let Some(receipt) = receipt {
            if receipt["state"] == "completed" {
                self.state.borrow_mut().pending = None;
                if pending.change_epoch {
                    self.changed();
                }
                if let Some(failure) = pending.terminal {
                    self.state.borrow_mut().failure = Some(failure.clone());
                    return Err(failure);
                }
                return Ok(());
            }
            if receipt["state"] != "blocked" || receipt["error"]["code"] != "storageWriteNotApplied"
            {
                return Err(Failure::new("storage_locked", "storage"));
            }
            pending.request_id = uuid::Uuid::new_v4().to_string();
            self.state.borrow_mut().pending = Some(pending.clone());
        }
        let current = self.accounts()?;
        let directory = current
            .directory
            .as_ref()
            .ok_or_else(|| Failure::new("account_changed", "account"))?;
        if current.revision.0 != pending.expected_revision
            || directory.active_id != pending.previous_active
            || directory
                .record(&pending.account)
                .ok_or_else(|| Failure::new("account_changed", "account"))?
                .grant()
                .map_err(Failure::storage)?
                .refresh
                != pending.previous_refresh
        {
            return Err(Failure::new("account_changed", "account"));
        }
        let receipt = self
            .migration
            .vault
            .replace_subscription_account(
                &self.source,
                &pending.request_id,
                pending.expected_revision,
                pending.directory.encode(),
                &self.migration,
            )
            .map_err(Failure::storage)?;
        if receipt["state"] != "completed" {
            return Err(Failure::new("storage_locked", "storage"));
        }
        self.state.borrow_mut().pending = None;
        if pending.change_epoch {
            self.changed();
        }
        if let Some(failure) = pending.terminal {
            self.state.borrow_mut().failure = Some(failure.clone());
            return Err(failure);
        }
        Ok(())
    }
    async fn rotate(
        &self,
        epoch: u64,
        force: bool,
        rejected: Option<String>,
    ) -> network::Result<AccessToken> {
        self.check_epoch(epoch)?;
        self.commit_pending()?;
        let accounts = self.accounts()?;
        let mut directory = accounts
            .directory
            .ok_or_else(|| Failure::new("credential_missing", "account"))?;
        let current = directory.active().clone();
        let grant = current.grant().map_err(Failure::storage)?;
        if grant.expires > now_ms() as f64 + 60_000.0
            && (!force
                || rejected
                    .as_deref()
                    .is_some_and(|token| token != grant.access))
        {
            current.usable_grant().map_err(Failure::storage)?;
            return Ok(AccessToken(grant.access.into()));
        }
        let previous_refresh = grant.refresh.to_owned();
        let (_, epoch_cancel) = self.epoch();
        let oauth = self.oauth.borrow().clone();
        let refreshed = tokio::select! {
            _=self.lifetime.cancelled()=>return Err(Failure::new("cancelled","refresh")),
            _=epoch_cancel.cancelled()=>return Err(Failure::new("account_changed","refresh")),
            result=oauth.refresh(&current)=>result,
        };
        self.check_epoch(epoch)?;
        let (next, terminal) = match refreshed {
            Ok(record) => (record, None),
            Err(failure) if failure.state() == "reauth_required" => {
                self.changed();
                (current.registration(true), Some(failure))
            }
            Err(failure) => return Err(failure),
        };
        let current_epoch = self.state.borrow().epoch;
        directory.replace_active(next);
        self.state.borrow_mut().pending = Some(PendingRotation {
            account: directory.active_id.clone(),
            previous_active: directory.active_id.clone(),
            change_epoch: false,
            epoch: current_epoch,
            expected_revision: accounts.revision.0,
            previous_refresh,
            directory,
            request_id: uuid::Uuid::new_v4().to_string(),
            terminal,
        });
        self.commit_pending()?;
        self.check_epoch(epoch)?;
        let accounts = self.accounts()?;
        let directory = accounts.directory.unwrap();
        Ok(AccessToken(
            directory
                .active()
                .usable_grant()
                .map_err(Failure::storage)?
                .access
                .into(),
        ))
    }
    async fn access_token(
        self: &Rc<Self>,
        cancel: &CancellationToken,
        force: bool,
        rejected: Option<String>,
    ) -> network::Result<AccessToken> {
        if cancel.is_cancelled() {
            return Err(Failure::new("cancelled", "authentication"));
        }
        let (epoch, epoch_cancel) = self.epoch();
        self.check_epoch(epoch)?;
        let receiver = self.state.borrow().flight.clone();
        let mut receiver = if let Some(receiver) = receiver {
            receiver
        } else {
            let (sender, receiver) = watch::channel(None);
            self.state.borrow_mut().flight = Some(receiver.clone());
            let owner = self.clone();
            self.track(tokio::task::spawn_local(async move {
                let result = owner.rotate(epoch, force, rejected).await;
                if owner.state.borrow().epoch == epoch {
                    let mut state = owner.state.borrow_mut();
                    state.flight = None;
                    state.failure = result.as_ref().err().cloned();
                }
                sender.send_replace(Some(result));
            }));
            receiver
        };
        loop {
            if let Some(result) = receiver.borrow().clone() {
                self.check_epoch(epoch)?;
                return result;
            }
            tokio::select! {
                biased;
                _=cancel.cancelled()=>return Err(Failure::new("cancelled","authentication")),
                _=epoch_cancel.cancelled()=>return Err(Failure::new("account_changed","authentication")),
                _=self.lifetime.cancelled()=>return Err(Failure::new("cancelled","authentication")),
                changed=receiver.changed()=>if changed.is_err() {return Err(Failure::new("cancelled","authentication"));},
            }
        }
    }
    fn logout(&self) -> network::Result<Option<account::AccountRecord>> {
        self.cancel_login();
        self.changed();
        let epoch = self.account_epoch();
        if let Some(pending) = self.state.borrow_mut().pending.as_mut() {
            pending.epoch = epoch;
        }
        if let Err(failure) = self.commit_pending()
            && self.state.borrow().pending.is_some()
        {
            return Err(failure);
        }
        let accounts = self.accounts()?;
        let Some(mut directory) = accounts.directory else {
            return Ok(None);
        };
        let record = directory.active().clone();
        if !record.authenticated() {
            directory.replace_active(record.registration(false));
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
            self.state.borrow_mut().failure = None;
            return Ok(None);
        }
        let previous_refresh = record.grant().map_err(Failure::storage)?.refresh.to_owned();
        let epoch = self.state.borrow().epoch;
        directory.replace_active(record.registration(false));
        self.state.borrow_mut().pending = Some(PendingRotation {
            account: directory.active_id.clone(),
            previous_active: directory.active_id.clone(),
            change_epoch: false,
            epoch,
            expected_revision: accounts.revision.0,
            previous_refresh,
            directory,
            request_id: uuid::Uuid::new_v4().to_string(),
            terminal: None,
        });
        self.commit_pending()?;
        self.state.borrow_mut().failure = None;
        Ok(Some(record))
    }
    pub(crate) async fn close(&self) {
        self.cancel_login();
        self.changed();
        self.lifetime.cancel();
        loop {
            let tasks = std::mem::take(&mut *self.tasks.borrow_mut());
            if tasks.is_empty() {
                break;
            }
            for task in tasks {
                let _ = task.await;
            }
        }
    }
}
