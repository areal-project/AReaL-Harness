use crate::wire::error;
use anyhow::Result;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

#[derive(Clone)]
pub(super) struct Secret(Value);

#[derive(Clone)]
pub(crate) struct AccountRecord {
    kind: RecordKind,
    metadata: Map<String, Value>,
    secrets: BTreeMap<String, Secret>,
    envelope: Map<String, Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecordKind {
    Registration,
    Grant,
}

#[derive(Clone)]
pub(super) struct AccountEntry {
    record: AccountRecord,
    metadata: Map<String, Value>,
}

#[derive(Clone)]
pub(super) struct AccountDirectory {
    pub(super) host_id: String,
    pub(super) active_id: String,
    records: BTreeMap<String, AccountEntry>,
    metadata: Map<String, Value>,
    envelope: Map<String, Value>,
}

pub(super) struct UsableGrant<'a> {
    pub(super) client_id: &'a str,
    pub(super) subject: &'a str,
    pub(super) access: &'a str,
    pub(super) refresh: &'a str,
    pub(super) expires: f64,
}

fn invalid() -> anyhow::Error {
    error("credentialInvalid", "invalid subscription credential")
}

fn object(value: Value) -> Result<Map<String, Value>> {
    value.as_object().cloned().ok_or_else(invalid)
}

fn text(value: Option<&Value>) -> Result<&str> {
    value.and_then(Value::as_str).ok_or_else(invalid)
}

impl AccountRecord {
    pub(super) fn authenticated(&self) -> bool {
        self.kind == RecordKind::Grant
    }
    pub(super) fn email(&self) -> Option<&str> {
        self.metadata.get("email").and_then(Value::as_str)
    }
    pub(super) fn requires_auth(&self) -> bool {
        self.metadata.get("reauthRequired") == Some(&Value::Bool(true))
    }
    pub(super) fn forget(&self) -> Result<Self> {
        if self.authenticated() {
            return Err(crate::wire::error(
                "operationBusy",
                "sign out before forgetting registration",
            ));
        }
        Ok(Self {
            kind: RecordKind::Registration,
            metadata: Map::from_iter([(
                "hostId".into(),
                self.metadata.get("hostId").cloned().unwrap_or(Value::Null),
            )]),
            secrets: BTreeMap::new(),
            envelope: self.envelope.clone(),
        })
    }
    pub(super) fn decode(value: Value) -> Result<Self> {
        let mut envelope = object(value)?;
        let kind = match text(envelope.get("kind"))? {
            "registration" => RecordKind::Registration,
            "grant" => RecordKind::Grant,
            _ => return Err(invalid()),
        };
        envelope.remove("kind");
        let mut metadata = object(envelope.remove("payload").ok_or_else(invalid)?)?;
        let secrets = ["access", "refresh", "idToken"]
            .into_iter()
            .filter_map(|key| {
                metadata
                    .remove(key)
                    .map(|value| (key.into(), Secret(value)))
            })
            .collect();
        Ok(Self {
            kind,
            metadata,
            secrets,
            envelope,
        })
    }

    pub(super) fn encode(&self) -> Value {
        let mut payload = self.metadata.clone();
        payload.extend(
            self.secrets
                .iter()
                .map(|(key, value)| (key.clone(), value.0.clone())),
        );
        let mut envelope = self.envelope.clone();
        envelope.insert(
            "kind".into(),
            json!(match self.kind {
                RecordKind::Registration => "registration",
                RecordKind::Grant => "grant",
            }),
        );
        envelope.insert("payload".into(), Value::Object(payload));
        Value::Object(envelope)
    }

    pub(super) fn usable_grant(&self) -> Result<UsableGrant<'_>> {
        let grant = self.grant()?;
        self.check_scopes()?;
        Ok(grant)
    }

    pub(super) fn grant(&self) -> Result<UsableGrant<'_>> {
        if self.kind != RecordKind::Grant
            || self.metadata.get("type").and_then(Value::as_str) != Some("oauth")
            || self.metadata.get("issuer").and_then(Value::as_str)
                != Some("https://auth.openai.com")
        {
            return Err(invalid());
        }
        let client_id = text(self.metadata.get("clientId"))?;
        let subject = text(self.metadata.get("subject"))?;
        let account_id = text(self.metadata.get("accountId"))?;
        let host_id = text(self.metadata.get("hostId"))?;
        if client_id.is_empty()
            || client_id.len() > 256
            || client_id == "dynamic_agent_client"
            || !client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || subject.is_empty()
            || account_id != subject
            || host_id.is_empty()
        {
            return Err(invalid());
        }
        let access = text(self.secrets.get("access").map(|value| &value.0))?;
        let refresh = text(self.secrets.get("refresh").map(|value| &value.0))?;
        if access.is_empty() || refresh.is_empty() {
            return Err(invalid());
        }
        let expires = self
            .metadata
            .get("expires")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .ok_or_else(invalid)?;
        Ok(UsableGrant {
            client_id,
            subject,
            access,
            refresh,
            expires,
        })
    }

    pub(super) fn check_scopes(&self) -> Result<()> {
        let scopes = self.metadata.get("scopes").and_then(Value::as_array);
        if !scopes.is_some_and(|scopes| {
            scopes.iter().all(Value::is_string)
                && ["resource.invoke", "chatgpt.tokens.use.direct"]
                    .into_iter()
                    .all(|scope| scopes.iter().any(|value| value.as_str() == Some(scope)))
        }) {
            return Err(error(
                "permissionMissing",
                "subscription grant lacks direct invocation scopes",
            ));
        }
        Ok(())
    }

    pub(super) fn rotated(&self, tokens: &Value, now: u64) -> Result<Self> {
        let mut record = self.clone();
        for (target, field) in [("access", "access_token"), ("refresh", "refresh_token")] {
            record
                .secrets
                .insert(target.into(), Secret(tokens[field].clone()));
        }
        if tokens.get("id_token").is_some_and(|value| !value.is_null()) {
            record
                .secrets
                .insert("idToken".into(), Secret(tokens["id_token"].clone()));
        }
        record.metadata.insert(
            "expires".into(),
            json!(now as f64 + tokens["expires_in"].as_f64().ok_or_else(invalid)? * 1000.0),
        );
        record.metadata.insert(
            "scopes".into(),
            json!(
                tokens["scope"]
                    .as_str()
                    .unwrap_or("")
                    .split_whitespace()
                    .collect::<Vec<_>>()
            ),
        );
        record.grant()?;
        Ok(record)
    }

    pub(super) fn registration(&self, reauth: bool) -> Self {
        let mut record = self.clone();
        record.kind = RecordKind::Registration;
        record.secrets.clear();
        record.metadata.remove("expires");
        record.metadata.remove("reauthRequired");
        if reauth {
            record.metadata.insert("reauthRequired".into(), json!(true));
        }
        record
    }
}

impl AccountDirectory {
    pub(super) fn decode(value: Value) -> Result<Self> {
        let envelope = object(value)?;
        if envelope.get("kind").and_then(Value::as_str) != Some("directory") {
            let record = AccountRecord::decode(Value::Object(envelope))?;
            let host_id = record
                .metadata
                .get("hostId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("urn:uuid:{}", uuid::Uuid::new_v4()));
            return Ok(Self {
                host_id,
                active_id: "primary".into(),
                records: BTreeMap::from([(
                    "primary".into(),
                    AccountEntry {
                        record,
                        metadata: Map::from_iter([("label".into(), json!("ChatGPT 1"))]),
                    },
                )]),
                metadata: Map::new(),
                envelope: Map::new(),
            });
        }
        let mut envelope = envelope;
        envelope.remove("kind");
        let mut metadata = object(envelope.remove("payload").ok_or_else(invalid)?)?;
        if metadata.remove("version") != Some(json!(1)) {
            return Err(invalid());
        }
        let host_id = text(metadata.get("hostId"))?.to_owned();
        let active_id = text(metadata.get("activeId"))?.to_owned();
        metadata.remove("hostId");
        metadata.remove("activeId");
        let records = object(metadata.remove("records").ok_or_else(invalid)?)?
            .into_iter()
            .map(|(id, entry)| {
                let mut entry = object(entry)?;
                let record = AccountRecord::decode(entry.remove("record").ok_or_else(invalid)?)?;
                Ok((
                    id,
                    AccountEntry {
                        record,
                        metadata: entry,
                    },
                ))
            })
            .collect::<Result<BTreeMap<_, _>>>()?;
        if !records.contains_key(&active_id) {
            return Err(invalid());
        }
        Ok(Self {
            host_id,
            active_id,
            records,
            metadata,
            envelope,
        })
    }

    pub(super) fn encode(&self) -> Value {
        let mut payload = self.metadata.clone();
        payload.insert("version".into(), json!(1));
        payload.insert("hostId".into(), json!(self.host_id));
        payload.insert("activeId".into(), json!(self.active_id));
        payload.insert(
            "records".into(),
            Value::Object(
                self.records
                    .iter()
                    .map(|(id, entry)| {
                        let mut value = entry.metadata.clone();
                        value.insert("record".into(), entry.record.encode());
                        (id.clone(), Value::Object(value))
                    })
                    .collect(),
            ),
        );
        let mut envelope = self.envelope.clone();
        envelope.insert("kind".into(), json!("directory"));
        envelope.insert("payload".into(), Value::Object(payload));
        Value::Object(envelope)
    }

    pub(super) fn active(&self) -> &AccountRecord {
        &self.records[&self.active_id].record
    }

    pub(super) fn replace_active(&mut self, record: AccountRecord) {
        self.records.get_mut(&self.active_id).unwrap().record = record;
    }
    pub(super) fn add_registration(&mut self) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let record = AccountRecord::decode(
            json!({"kind":"registration","payload":{"hostId":self.host_id}}),
        )?;
        self.records.insert(
            id.clone(),
            AccountEntry {
                record,
                metadata: Map::from_iter([(
                    "label".into(),
                    json!(format!("ChatGPT {}", self.records.len() + 1)),
                )]),
            },
        );
        Ok(id)
    }
    pub(super) fn replace(&mut self, id: &str, record: AccountRecord) -> Result<()> {
        self.records
            .get_mut(id)
            .ok_or_else(|| crate::wire::error("accountChanged", "account is missing"))?
            .record = record;
        Ok(())
    }
    pub(super) fn record(&self, id: &str) -> Option<&AccountRecord> {
        self.records.get(id).map(|entry| &entry.record)
    }
    pub(super) fn select(&mut self, id: &str) -> Result<()> {
        if !self.records.contains_key(id) {
            return Err(crate::wire::error(
                "accountChanged",
                "subscription account is missing",
            ));
        }
        self.active_id = id.to_owned();
        Ok(())
    }

    pub(super) fn public(&self) -> Value {
        json!({
            "activeAccountId":self.active_id,
            "accounts":self.records.iter().map(|(id, entry)| json!({
                "id":id,
                "label":entry.metadata.get("label").and_then(Value::as_str),
                "email":entry.record.metadata.get("email").and_then(Value::as_str),
                "active":id == &self.active_id,
                "state":if entry.record.kind == RecordKind::Grant { "saved" }
                    else if entry.record.metadata.get("reauthRequired") == Some(&Value::Bool(true)) { "reauth_required" }
                    else { "signed_out" },
                "billing":"subscription"
            })).collect::<Vec<_>>()
        })
    }
}
