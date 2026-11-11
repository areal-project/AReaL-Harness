use super::*;

#[test]
fn source_credential_metadata_survives_retirement_and_discovers_new_slots() {
    let fixture = Fixture::new(&[
        ("provider-credentials.json", br#"{"keys":{"AREAL_CREDENTIAL_old":"cipher"},"migrated":["/old/config"]}"#),
        ("providers.json", br#"{"data":[{"id":"legacy","secret":"cipher","name":"Legacy"},{"id":"public","secret":""}],"retired":["removed"]}"#),
    ]);
    let view = || {
        fixture
            .migration
            .source(fixture.source.clone(), &[])
            .unwrap()["credentials"]
            .clone()
    };
    let before = view();
    assert_eq!(
        before["references"],
        json!(["AREAL_CREDENTIAL_legacy", "AREAL_CREDENTIAL_old"])
    );
    assert_eq!(before["migratedConfigPaths"], json!(["/old/config"]));
    assert_eq!(
        before["legacyProviders"]["data"][0]["apiKeyEnv"],
        "AREAL_CREDENTIAL_legacy"
    );
    assert!(before["legacyProviders"]["data"][0].get("secret").is_none());
    assert!(
        before["legacyProviders"]["data"][1]
            .get("apiKeyEnv")
            .is_none()
    );
    fixture.finish(&fixture.migration);
    assert_eq!(view(), before);
    let source_id = fixture
        .migration
        .read(&fixture.migration_id)
        .unwrap()
        .source_id;
    let slot = vault::Slot::ProviderCredential {
        source_id: source_id.clone(),
        reference: "AREAL_CREDENTIAL_new".into(),
    };
    for (revision, value) in [(0, json!("new-secret")), (1, Value::Null)] {
        fixture
            .migration
            .vault
            .dispatch(
                "vault.replace",
                json!({
                    "requestId":uuid::Uuid::new_v4().to_string(), "expectedGeneration":"generation",
                    "slot":slot, "expectedRevision":revision, "value":value
                }),
                "generation",
                &fixture.migration,
            )
            .unwrap();
    }
    assert_eq!(
        view()["references"],
        json!([
            "AREAL_CREDENTIAL_legacy",
            "AREAL_CREDENTIAL_new",
            "AREAL_CREDENTIAL_old"
        ])
    );
    let transport = vault::Slot::SubscriptionTransport { source_id };
    let project = fixture.migration.published().unwrap().remove(0);
    for (revision, value, expected) in [
        (
            0,
            json!({"token":"transport-token","port":1234}),
            Some("transport-token"),
        ),
        (1, Value::Null, None),
    ] {
        fixture
            .migration
            .vault
            .dispatch(
                "vault.replace",
                json!({
                    "requestId":uuid::Uuid::new_v4().to_string(), "expectedGeneration":"generation",
                    "slot":transport, "expectedRevision":revision, "value":value
                }),
                "generation",
                &fixture.migration,
            )
            .unwrap();
        assert_eq!(
            fixture
                .migration
                .credential(&project, "AREAL_CREDENTIAL_areal_openai")
                .unwrap()
                .as_deref(),
            expected
        );
    }
    let record = fixture.migration.read(&fixture.migration_id).unwrap();
    let backup = record
        .originals
        .iter()
        .find(|f| f.relative_name == "providers.json")
        .unwrap();
    let Original::Bytes { backup_id, .. } = &backup.original else {
        panic!("missing backup")
    };
    storage::write_bytes(
        &fixture
            .migration
            .directory(&fixture.migration_id)
            .unwrap()
            .join("backups")
            .join(format!("{backup_id}.bytes")),
        br#"{"data":[]}"#,
    )
    .unwrap();
    assert!(
        fixture
            .migration
            .source(fixture.source.clone(), &[])
            .is_err()
    );
}

struct Fixture {
    _root: tempfile::TempDir,
    migration: Migration,
    source: Source,
    migration_id: String,
    request: String,
}
impl Fixture {
    fn new(files: &[(&str, &[u8])]) -> Self {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let home = base.join("home");
        storage::private_dir(&home.join("host")).unwrap();
        let core = base.join("core");
        storage::private_dir(&core).unwrap();
        let source = Source {
            profile: base.join("profile"),
            core_home: core.clone(),
            legacy_service_home: base.join("legacy"),
        };
        storage::private_dir(&source.profile).unwrap();
        let workspace = base.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        storage::write(
            &core.join("projects.json"),
            &json!([{"id":"a".repeat(24),"root":workspace}]),
        )
        .unwrap();
        storage::write(
            &core.join(format!("{}-pending.json", "a".repeat(24))),
            &json!([]),
        )
        .unwrap();
        for (name, bytes) in files {
            storage::write_bytes(&core.join(name), bytes).unwrap();
        }
        let mut migration = Migration::new(&home).unwrap();
        migration.vault = vault::Vault::isolated_files(&home);
        migration
            .attach(source.clone(), "connection", None)
            .unwrap();
        let migration_id = uuid::Uuid::new_v4().to_string();
        let fixture = Self {
            _root: root,
            migration,
            source,
            migration_id,
            request: uuid::Uuid::new_v4().to_string(),
        };
        fixture.import();
        fixture
    }
    fn import(&self) {
        let journal = crate::journal::Journal::new(&self.migration.home).unwrap();
        let input = || Import {
            request_id: self.migration_id.clone(),
            expected_generation: "generation".into(),
            source: self.source.clone(),
        };
        self.migration
            .import(input(), "connection", &[], &journal)
            .unwrap();
        let record = self.migration.read(&self.migration_id).unwrap();
        for secret in &record.secrets {
            let value = match secret.slot {
                vault::Slot::ProviderCredential { .. } => json!("original-private-value"),
                vault::Slot::RemoteIdentity => {
                    json!({"identity":"private-noise","deviceGrants":[]})
                }
                _ => json!({"token":"original-private-value","port":1234}),
            };
            self.migration
                .import_secret(
                    ImportSecret {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        expected_generation: "generation".into(),
                        migration_id: self.migration_id.clone(),
                        slot: secret.slot.clone(),
                        source_digest: secret.source_digest.clone(),
                        value,
                    },
                    "connection",
                )
                .unwrap();
        }
        assert_eq!(
            self.migration
                .import(input(), "connection", &[], &journal)
                .unwrap()["kind"],
            "ready"
        );
    }
    fn prepare_on(&self, migration: &Migration) -> Result<Value> {
        migration.retirement_prepare(
            Prepare {
                request_id: self.request.clone(),
                migration_id: self.migration_id.clone(),
                expected_generation: "generation".into(),
            },
            "connection",
        )
    }
    fn prepare(&self) -> Result<Value> {
        self.prepare_on(&self.migration)
    }
    fn confirm_on(&self, migration: &Migration, progress: &Value) -> Result<Value> {
        migration.retirement_confirm(
            Confirm {
                request_id: self.request.clone(),
                migration_id: self.migration_id.clone(),
                plan_id: progress["planId"].as_str().unwrap().into(),
                expected_generation: "generation".into(),
            },
            "connection",
        )
    }
    fn rename_without_directory_sync(&self, migration: &Migration, progress: &Value) {
        let target: Target = serde_json::from_value(progress["next"].clone()).unwrap();
        let bytes = std::fs::read(
            migration
                .directory(&self.migration_id)
                .unwrap()
                .join("retirement")
                .join(progress["planId"].as_str().unwrap())
                .join(format!("{}.bytes", target.backup_id)),
        )
        .unwrap();
        assert_eq!(bytes.len() as u64, target.byte_length);
        assert_eq!(storage::digest(&bytes), target.after_digest);
        let record = migration.read(&self.migration_id).unwrap();
        let path = migration.retirement_target_path(&record, &target).unwrap();
        let temporary = path
            .parent()
            .unwrap()
            .join(format!(".fixture-{}.tmp", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .unwrap();
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        std::fs::rename(temporary, path).unwrap();
    }
    fn finish(&self, migration: &Migration) -> Value {
        loop {
            let progress = self.prepare_on(migration).unwrap();
            if progress["state"] == "completed" {
                return progress;
            }
            self.rename_without_directory_sync(migration, &progress);
            let confirmed = self.confirm_on(migration, &progress).unwrap();
            assert!(confirmed["next"].is_null());
        }
    }
}

#[test]
fn retirement_removes_only_manifest_fields_preserves_values_and_original_receipts() {
    let f = Fixture::new(&[
        ("provider-credentials.json", br#"{"keys":{"AREAL_CREDENTIAL_old":"cipher-old"},"migrated":["old"],"future":{"large":123456789012345678901234567890,"n":1.2300e+4}}"#),
        ("providers.json", br#"{"data":[{"id":"one","secret":"cipher-provider","enabled":false,"future":{"raw":"\u0041"}},{"id":"two","label":"unchanged"}],"future":[true, null]}"#),
        ("openai-subscription.json", br#"{"secret":"cipher-account","future":"\u0041"}"#),
        ("subscription-transport.json", br#"{"token":"plain-transport-capability","port":1234,"future":1.2300e+4}"#),
        ("remote.json", br#"{"encrypted":"cipher-remote","future":{"large":123456789012345678901234567890}}"#),
    ]);
    let directory = f.migration.directory(&f.migration_id).unwrap();
    let record_bytes = std::fs::read(directory.join("record.json")).unwrap();
    let commit_bytes = std::fs::read(directory.join("committed.json")).unwrap();
    let record = f.migration.read(&f.migration_id).unwrap();
    let journal_backup = record
        .originals
        .iter()
        .find(|file| file.role == "pending")
        .unwrap();
    let Original::Bytes { backup_id, .. } = &journal_backup.original else {
        panic!("missing journal backup")
    };
    let journal_path = directory.join("backups").join(format!("{backup_id}.bytes"));
    let journal_bytes = std::fs::read(&journal_path).unwrap();
    let fence = std::fs::read(f.source.core_home.join("provider-credentials.json")).unwrap();
    let completed = f.finish(&f.migration);
    assert_eq!(completed["state"], "completed");
    assert_eq!(
        std::fs::read(directory.join("record.json")).unwrap(),
        record_bytes
    );
    assert_eq!(
        std::fs::read(directory.join("committed.json")).unwrap(),
        commit_bytes
    );
    assert_eq!(std::fs::read(journal_path).unwrap(), journal_bytes);
    assert_eq!(
        std::fs::read(f.source.core_home.join("provider-credentials.json")).unwrap(),
        fence
    );
    for file in &record.originals {
        if !record
            .secrets
            .iter()
            .any(|secret| secret.relative_name == file.relative_name)
        {
            continue;
        }
        let Original::Bytes { backup_id, .. } = &file.original else {
            unreachable!()
        };
        let backup =
            std::fs::read_to_string(directory.join("backups").join(format!("{backup_id}.bytes")))
                .unwrap();
        assert!(!backup.contains("cipher-") && !backup.contains("plain-transport-capability"));
        assert!(backup.contains("future"));
        if file.role == "providerCredentials" || file.role == "remote" {
            assert!(backup.contains("123456789012345678901234567890"));
        }
        if file.role == "providerCredentials" || file.role == "subscriptionTransport" {
            assert!(backup.contains("1.2300e+4"));
        }
        if file.role == "subscriptionAccount" || file.role == "providers" {
            assert!(backup.contains(r"\u0041"));
        }
        if file.role != "providerCredentials" {
            assert_eq!(
                std::fs::read_to_string(f.source.core_home.join(&file.relative_name)).unwrap(),
                backup
            );
        }
    }
    assert!(f.migration.status(&f.migration_id).unwrap()["receipt"]["retirement"] == "pending");
    f.migration.vault.locked.set(true);
    f.migration.disconnect("connection");
    assert_eq!(f.prepare().unwrap(), completed);
    assert_eq!(
        f.migration.retirement_status(&f.migration_id).unwrap(),
        completed
    );
    let operation = crate::operation_offline(&f.migration.home, &f.request)
        .unwrap()
        .unwrap();
    assert_eq!(operation["state"], "completed");
    assert_eq!(operation["method"], "gui.retirementPrepare");
    assert_eq!(operation["result"], completed);
    let stored_plan = std::fs::read_to_string(directory.join("retirement.json")).unwrap();
    assert!(
        !stored_plan.contains("cipher-")
            && !stored_plan.contains("plain-transport-capability")
            && !stored_plan.contains("future")
    );
}

#[test]
fn retirement_restart_reconciles_rename_without_confirm_and_never_restores_rotated_slot() {
    let f = Fixture::new(&[(
        "subscription-transport.json",
        br#"{"token":"old-transport","port":1234}"#,
    )]);
    let record = f.migration.read(&f.migration_id).unwrap();
    let slot = &record.secrets[0].slot;
    for (revision, value) in [
        (1, json!({"token":"replacement","port":2345})),
        (2, Value::Null),
    ] {
        f.migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":slot,"expectedRevision":revision,"value":value}), "generation", &f.migration).unwrap();
    }
    let progress = f.prepare().unwrap();
    assert_eq!(progress["next"]["site"], "source");
    f.rename_without_directory_sync(&f.migration, &progress);
    let pending = crate::operation_offline(&f.migration.home, &f.request)
        .unwrap()
        .unwrap();
    assert_eq!(pending["state"], "acceptedPending");
    assert!(pending["result"]["next"].is_null());
    let mut restarted = Migration::new(&f.migration.home).unwrap();
    restarted.vault = vault::Vault::isolated_files(&f.migration.home);
    restarted
        .attach(f.source.clone(), "connection", None)
        .unwrap();
    let resumed = f.prepare_on(&restarted).unwrap();
    assert_eq!(resumed["planId"], progress["planId"]);
    assert_eq!(resumed["next"]["site"], "backup");
    f.rename_without_directory_sync(&restarted, &resumed);
    let mut restarted = Migration::new(&f.migration.home).unwrap();
    restarted.vault = vault::Vault::isolated_files(&f.migration.home);
    restarted.vault.locked.set(true);
    restarted
        .attach(f.source.clone(), "connection", None)
        .unwrap();
    let completed = f.prepare_on(&restarted).unwrap();
    assert_eq!(completed["state"], "completed");
    assert!(completed["next"].is_null());
    restarted.vault.locked.set(false);
    assert_eq!(
        restarted
            .vault
            .dispatch("vault.read", json!({"slot":slot}), "generation", &restarted)
            .unwrap(),
        json!({"revision":3,"value":null})
    );
    assert!(
        restarted
            .vault
            .read(&record.secrets[0].entry_id)
            .unwrap()
            .is_some()
    );
}

#[test]
fn locked_retirement_preserves_committed_source_and_resumes_original_request() {
    let f = Fixture::new(&[(
        "subscription-transport.json",
        br#"{"token":"original","port":1234}"#,
    )]);
    let directory = f.migration.directory(&f.migration_id).unwrap();
    let committed = std::fs::read(directory.join("committed.json")).unwrap();
    let source = f.source.core_home.join("subscription-transport.json");
    let original = std::fs::read(&source).unwrap();
    f.migration.vault.locked.set(true);
    assert!(
        f.prepare()
            .unwrap_err()
            .to_string()
            .contains("storageLocked")
    );
    assert!(
        f.migration
            .retirement_status(&f.migration_id)
            .unwrap()
            .is_null()
    );
    assert_eq!(
        std::fs::read(directory.join("committed.json")).unwrap(),
        committed
    );
    assert_eq!(std::fs::read(&source).unwrap(), original);

    f.migration.vault.locked.set(false);
    let completed = f.finish(&f.migration);
    assert_eq!(completed["requestId"], f.request);
    assert_eq!(completed["state"], "completed");
    assert_eq!(
        std::fs::read(directory.join("committed.json")).unwrap(),
        committed
    );
}

#[test]
fn retirement_missing_or_locked_original_entry_blocks_even_when_new_slot_exists() {
    for missing in [false, true] {
        let f = Fixture::new(&[(
            "subscription-transport.json",
            br#"{"token":"original","port":1234}"#,
        )]);
        let record = f.migration.read(&f.migration_id).unwrap();
        let secret = &record.secrets[0];
        f.migration.vault.dispatch("vault.replace", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedGeneration":"generation","slot":secret.slot,"expectedRevision":1,"value":{"token":"new","port":2345}}), "generation", &f.migration).unwrap();
        let progress = f.prepare().unwrap();
        f.rename_without_directory_sync(&f.migration, &progress);
        f.confirm_on(&f.migration, &progress).unwrap();
        if missing {
            std::fs::remove_file(
                f.migration
                    .home
                    .join("host/vault")
                    .join(format!("{}.json", secret.entry_id)),
            )
            .unwrap();
        } else {
            f.migration.vault.locked.set(true);
        }
        let error = f.prepare().unwrap_err().to_string();
        assert!(
            error.contains(if missing {
                "storageMissing"
            } else {
                "storageLocked"
            }),
            "{error}"
        );
        let pending = crate::operation_offline(&f.migration.home, &f.request)
            .unwrap()
            .unwrap();
        assert_eq!(pending["state"], "acceptedPending");
        assert!(pending["result"]["next"].is_null());
        let status = f.migration.retirement_status(&f.migration_id).unwrap();
        assert_eq!(status["state"], "applying");
        let backup: Value = serde_json::from_slice(
            &std::fs::read(
                f.migration
                    .directory(&f.migration_id)
                    .unwrap()
                    .join("backups")
                    .join(format!(
                        "{}.bytes",
                        match &record
                            .originals
                            .iter()
                            .find(|file| file.role == "subscriptionTransport")
                            .unwrap()
                            .original
                        {
                            Original::Bytes { backup_id, .. } => backup_id,
                            _ => unreachable!(),
                        }
                    )),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(backup["token"], "original");
    }
}

#[test]
fn retirement_rejects_changed_targets_missing_targets_symlinks_and_fences() {
    for kind in ["changed", "missing", "symlink", "fence", "unprivate"] {
        let f = Fixture::new(&[(
            "subscription-transport.json",
            br#"{"token":"original","port":1234}"#,
        )]);
        let progress = f.prepare().unwrap();
        let path = f.source.core_home.join("subscription-transport.json");
        match kind {
            "changed" => storage::write_bytes(&path, br#"{"token":"newer","port":1234}"#).unwrap(),
            "missing" => std::fs::remove_file(&path).unwrap(),
            "symlink" => {
                std::fs::remove_file(&path).unwrap();
                std::os::unix::fs::symlink(f.source.core_home.join("projects.json"), &path)
                    .unwrap();
            }
            "fence" => storage::write_bytes(
                &f.source.core_home.join("provider-credentials.json"),
                b"changed",
            )
            .unwrap(),
            "unprivate" => {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            f.prepare()
                .unwrap_err()
                .to_string()
                .contains("sourceChanged"),
            "{kind}"
        );
        assert!(
            f.confirm_on(&f.migration, &progress)
                .unwrap_err()
                .to_string()
                .contains("sourceChanged"),
            "{kind}"
        );
        assert_eq!(
            f.migration.retirement_status(&f.migration_id).unwrap()["state"],
            "applying"
        );
    }
}

#[test]
fn retirement_request_identity_guard_and_wrong_plan_are_rejected() {
    let f = Fixture::new(&[(
        "subscription-transport.json",
        br#"{"token":"original","port":1234}"#,
    )]);
    f.migration.disconnect("connection");
    assert!(
        f.prepare()
            .unwrap_err()
            .to_string()
            .contains("sourceGuardRequired")
    );
    assert!(
        f.migration
            .retirement_status(&f.migration_id)
            .unwrap()
            .is_null()
    );
    f.migration
        .attach(f.source.clone(), "connection", None)
        .unwrap();
    let progress = f.prepare().unwrap();
    let duplicate = f
        .migration
        .retirement_prepare(
            Prepare {
                request_id: uuid::Uuid::new_v4().to_string(),
                migration_id: f.migration_id.clone(),
                expected_generation: "generation".into(),
            },
            "connection",
        )
        .unwrap_err();
    assert!(duplicate.to_string().contains("requestConflict"));
    let wrong = f
        .migration
        .retirement_confirm(
            Confirm {
                request_id: f.request.clone(),
                migration_id: f.migration_id.clone(),
                plan_id: uuid::Uuid::new_v4().to_string(),
                expected_generation: "generation".into(),
            },
            "connection",
        )
        .unwrap_err();
    assert!(wrong.to_string().contains("requestConflict"));
    assert_eq!(
        f.confirm_on(&f.migration, &progress).unwrap()["state"],
        "applying"
    );
    assert_eq!(f.prepare().unwrap()["next"], progress["next"]);
}

#[test]
fn retirement_rejects_duplicate_keys_nested_duplicates_and_explicit_schema_without_writes() {
    for bytes in [
        br#"{"token":"one","token":"two","port":1234}"#.as_slice(),
        br#"{"token":"one","port":1234,"future":{"nested":1,"nested":2}}"#.as_slice(),
        br#"{"token":"one","port":1234,"schemaVersion":2}"#.as_slice(),
    ] {
        let f = Fixture::new(&[("subscription-transport.json", bytes)]);
        assert!(
            f.prepare()
                .unwrap_err()
                .to_string()
                .contains("unsupportedSourceShape")
        );
        assert_eq!(
            std::fs::read(f.source.core_home.join("subscription-transport.json")).unwrap(),
            bytes
        );
        assert!(
            f.migration
                .retirement_status(&f.migration_id)
                .unwrap()
                .is_null()
        );
    }
}

#[test]
fn retirement_large_unknown_values_use_derivative_files_and_metadata_only_wire() {
    let future = "x".repeat(wire::MAX_FRAME + 100);
    let original =
        serde_json::to_vec(&json!({"token":"original","port":1234,"future":future})).unwrap();
    let f = Fixture::new(&[("subscription-transport.json", &original)]);
    let progress = f.prepare().unwrap();
    assert!(progress["next"]["byteLength"].as_u64().unwrap() > wire::MAX_FRAME as u64);
    assert!(serde_json::to_vec(&progress).unwrap().len() < 1024);
    assert!(progress["next"].get("bytesBase64").is_none());
    f.finish(&f.migration);
    let retired: Value = serde_json::from_slice(
        &std::fs::read(f.source.core_home.join("subscription-transport.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(retired["future"], future);
    assert!(retired.get("token").is_none());
}
