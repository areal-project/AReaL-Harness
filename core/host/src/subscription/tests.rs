use super::*;
use crate::{
    journal::Journal,
    migration::{Import, Source},
    vault::Slot,
};
use areal_local_service::storage;
use serde_json::json;

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/session-directory.json")).unwrap()
}

pub(super) fn grant() -> Value {
    json!({"kind":"grant","payload":{
        "hostId":"urn:uuid:fixture","clientId":"client-one","subject":"subject-one",
        "accountId":"subject-one","email":"same@fixture.invalid","issuer":"https://auth.openai.com",
        "type":"oauth","access":"secret-access","refresh":"secret-refresh","idToken":"secret-id",
        "expires":2000000000000u64,"scopes":["openid","resource.invoke","chatgpt.tokens.use.direct"],
        "supportedExtension":{"value":1}
    }})
}

pub(super) struct Fixture {
    pub(super) root: tempfile::TempDir,
    pub(super) home: std::path::PathBuf,
    pub(super) migration: Migration,
    pub(super) sources: Vec<String>,
}

impl Fixture {
    pub(super) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        storage::private_dir(&home.join("host")).unwrap();
        let mut migration = Migration::new(&home).unwrap();
        migration.vault = Vault::isolated_files(&home);
        let sources = (0..2).map(|index| {
            let core = root.path().join(format!("core-{index}"));
            let profile = root.path().join(format!("profile-{index}"));
            let workspace = root.path().join(format!("workspace-{index}"));
            storage::private_dir(&core).unwrap();
            storage::private_dir(&profile).unwrap();
            std::fs::create_dir(&workspace).unwrap();
            storage::write(&core.join("projects.json"), &json!([{"id":format!("{index:024}"),"root":workspace}])).unwrap();
            let source = Source { profile, core_home:core, legacy_service_home:root.path().join(format!("legacy-{index}")) };
            migration.attach(source.clone(), "fixture", None).unwrap();
            let imported = migration.import(serde_json::from_value::<Import>(json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"fixture","source":source})).unwrap(), "fixture", &[], &Journal::new(&home).unwrap()).unwrap();
            assert_eq!(imported["kind"], "ready");
            imported["receipt"]["sourceId"].as_str().unwrap().to_owned()
        }).collect();
        Self {
            root,
            home,
            migration,
            sources,
        }
    }

    fn write(&self, source: usize, id: &str, revision: u64, value: Value) -> Result<Value> {
        self.migration.vault.replace_subscription_account(
            &self.sources[source],
            id,
            revision,
            value,
            &self.migration,
        )
    }

    fn read(&self, source: usize) -> SourceAccounts {
        SourceAccounts::read(
            &self.migration.vault,
            &self.sources[source],
            &self.migration,
        )
        .unwrap()
    }
}

#[test]
fn js_directory_corpus_preserves_payload_and_public_projection() {
    let corpus = golden();
    let migrated = AccountDirectory::decode(corpus["legacy"].clone()).unwrap();
    assert_eq!(migrated.active_id, "primary");
    assert_eq!(migrated.host_id, "urn:uuid:fixture");
    assert_eq!(
        migrated.encode()["payload"]["records"]["primary"]["record"],
        corpus["legacy"]
    );
    let directory = AccountDirectory::decode(corpus["record"].clone()).unwrap();
    assert_eq!(directory.encode(), corpus["record"]);
    assert_eq!(directory.public(), corpus["public"]);
    assert!(
        directory.active().usable_grant().is_err(),
        "legacy persistence corpus is not an executable OAuth grant"
    );
    let mut full = corpus["record"].clone();
    full["outerExtension"] = json!(true);
    full["payload"]["directoryExtension"] = json!({"supported":1});
    full["payload"]["records"]["primary"]["entryExtension"] = json!(2);
    assert_eq!(
        AccountDirectory::decode(full.clone()).unwrap().encode(),
        full
    );
}

#[test]
fn registration_and_grant_keep_exact_storage_shapes_and_secrets_private() {
    for record in [
        json!({"kind":"registration","payload":{"hostId":"urn:uuid:fixture"}}),
        json!({"kind":"registration","payload":{"hostId":"urn:uuid:fixture","clientId":"client-one","subject":"subject-one","email":"same@fixture.invalid","issuer":"https://auth.openai.com","reauthRequired":true}}),
        grant(),
    ] {
        let directory = AccountDirectory::decode(record.clone()).unwrap();
        assert_eq!(
            directory.encode()["payload"]["records"]["primary"]["record"],
            record
        );
        let public = serde_json::to_string(&directory.public()).unwrap();
        for secret in [
            "secret-access",
            "secret-refresh",
            "secret-id",
            "client-one",
            "subject-one",
            "urn:uuid:fixture",
        ] {
            assert!(!public.contains(secret));
        }
    }
    let directory = AccountDirectory::decode(grant()).unwrap();
    let usable = directory.active().usable_grant().unwrap();
    assert_eq!(
        (
            usable.client_id,
            usable.subject,
            usable.access,
            usable.refresh,
            usable.expires
        ),
        (
            "client-one",
            "subject-one",
            "secret-access",
            "secret-refresh",
            2000000000000.0
        )
    );
    for (field, value) in [
        ("issuer", json!("https://other.invalid")),
        ("type", json!("apiKey")),
        ("accountId", json!("other-subject")),
        ("clientId", json!("dynamic_agent_client")),
        ("access", json!("")),
    ] {
        let mut record = grant();
        record["payload"][field] = value;
        let directory = AccountDirectory::decode(record).unwrap();
        assert!(
            directory
                .active()
                .usable_grant()
                .err()
                .unwrap()
                .to_string()
                .contains("credentialInvalid"),
            "{field}"
        );
    }
    for scopes in [
        None,
        Some(Value::Null),
        Some(json!("resource.invoke chatgpt.tokens.use.direct")),
        Some(json!(["resource.invoke", "chatgpt.tokens.use.direct", 1])),
        Some(json!(["resource.invoke"])),
        Some(json!(["chatgpt.tokens.use.direct"])),
    ] {
        let mut record = grant();
        match scopes {
            Some(value) => record["payload"]["scopes"] = value,
            None => {
                record["payload"].as_object_mut().unwrap().remove("scopes");
            }
        }
        let directory = AccountDirectory::decode(record.clone()).unwrap();
        let failure = directory.active().usable_grant().err().unwrap();
        assert_eq!(
            failure.downcast_ref::<crate::wire::Error>().unwrap().code,
            "permissionMissing"
        );
        assert_eq!(
            directory.encode()["payload"]["records"]["primary"]["record"],
            record
        );
        record["payload"]["access"] = json!("");
        let directory = AccountDirectory::decode(record).unwrap();
        let failure = directory.active().usable_grant().err().unwrap();
        assert_eq!(
            failure.downcast_ref::<crate::wire::Error>().unwrap().code,
            "credentialInvalid"
        );
    }
}

#[test]
fn committed_sources_with_same_email_remain_separate_and_restart_preserves_revocation() {
    let f = Fixture::new();
    assert_ne!(f.sources[0], f.sources[1]);
    assert_eq!(f.read(0).revision, VaultRevision(0));
    assert_eq!(
        f.read(0).public(),
        json!({"activeAccountId":null,"accounts":[]})
    );
    let one = f
        .write(0, &uuid::Uuid::new_v4().to_string(), 0, grant())
        .unwrap();
    let mut other = grant();
    other["payload"]["hostId"] = json!("urn:uuid:source-two");
    other["payload"]["clientId"] = json!("client-two");
    other["payload"]["subject"] = json!("subject-two");
    other["payload"]["accountId"] = json!("subject-two");
    f.write(1, &uuid::Uuid::new_v4().to_string(), 0, other.clone())
        .unwrap();
    assert_eq!(
        f.read(1).directory.unwrap().encode()["payload"]["records"]["primary"]["record"],
        other
    );
    assert_eq!(
        f.read(0)
            .directory
            .unwrap()
            .active()
            .usable_grant()
            .unwrap()
            .client_id,
        "client-one"
    );
    assert!(
        f.write(0, &uuid::Uuid::new_v4().to_string(), 0, grant())
            .unwrap_err()
            .to_string()
            .contains("revisionConflict")
    );
    f.write(0, &uuid::Uuid::new_v4().to_string(), 1, Value::Null)
        .unwrap();
    let restarted = Vault::isolated_files(&f.home);
    let accounts = SourceAccounts::read(&restarted, &f.sources[0], &f.migration).unwrap();
    assert_eq!(accounts.revision, VaultRevision(2));
    assert!(accounts.directory.is_none());
    assert_eq!(
        restarted.read(one["entryId"].as_str().unwrap()).unwrap(),
        Some(grant())
    );
    assert_eq!(
        SourceAccounts::read(&restarted, &f.sources[1], &f.migration)
            .unwrap()
            .revision,
        VaultRevision(1)
    );
    assert!(
        SourceAccounts::read(&restarted, &uuid::Uuid::new_v4().to_string(), &f.migration)
            .err()
            .unwrap()
            .to_string()
            .contains("sourceNotFound")
    );
    assert!(f.root.path().exists());
}

#[test]
fn unclaimed_sources_keep_generic_writes_and_native_capability_is_explicit() {
    let f = Fixture::new();
    let slot = Slot::SubscriptionAccount {
        source_id: f.sources[0].clone(),
        provider_id: "openai".into(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let params = json!({"requestId":id,"expectedGeneration":"fixture","slot":slot,"expectedRevision":0,"value":grant()});
    let receipt = f
        .migration
        .vault
        .dispatch("vault.replace", params.clone(), "fixture", &f.migration)
        .unwrap();
    assert_eq!(receipt["revision"], 1);
    std::fs::remove_file(
        f.home
            .join("host/vault-operations")
            .join(format!("{id}.json")),
    )
    .unwrap();
    assert_eq!(
        f.migration.vault.operation(&id, &f.migration).unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(f.write(0, &id, 0, grant()).unwrap(), receipt);
    let mut bypass = params;
    bypass["nativeOwner"] = json!(true);
    assert!(
        f.migration
            .vault
            .dispatch("vault.replace", bypass, "fixture", &f.migration)
            .is_err()
    );
    for slot in [
        Slot::SubscriptionTransport {
            source_id: f.sources[0].clone(),
        },
        Slot::ProviderCredential {
            source_id: f.sources[0].clone(),
            reference: "AREAL_CREDENTIAL_fixture".into(),
        },
    ] {
        let value = if matches!(slot, Slot::ProviderCredential { .. }) {
            json!("fixture-key")
        } else {
            json!({"token":"fixture-token","port":12345})
        };
        assert_eq!(f.migration.vault.dispatch("vault.replace",json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"fixture","slot":slot,"expectedRevision":0,"value":value}),"fixture",&f.migration).unwrap()["state"], "completed");
    }
    assert!(crate::CAPABILITIES.contains(&"subscriptionOwnerV1"));
}
